export var vertRenderShader = `#version 300 es
#line 4
layout(location=0) in vec3 pos;
layout(location=1) in vec3 texCoords;
uniform mat4 mvpMtx;
out vec3 vColor;
void main(void) {
	gl_Position = mvpMtx * vec4(pos, 1.0);
	vColor = texCoords;
}`;

const kDrawFunc = `
	vec4 drawColor(float scalar) {
		float nlayer = float(textureSize(colormap, 0).y);
		float layer = (nlayer - 0.5) / nlayer;
		vec4 dcolor = texture(colormap, vec2(scalar * 255.0/256.0 + 0.5/256.0, layer)).rgba;
		dcolor.a *= drawOpacity;
		return dcolor;
}`;

const kRenderFunc =
  `vec3 GetBackPosition(vec3 startPositionTex) {
	vec3 startPosition = startPositionTex * volScale;
	vec3 invR = 1.0 / rayDir;
	vec3 tbot = invR * (vec3(0.0)-startPosition);
	vec3 ttop = invR * (volScale-startPosition);
	vec3 tmax = max(ttop, tbot);
	vec2 t = min(tmax.xx, tmax.yz);
	vec3 endPosition = startPosition + (rayDir * min(t.x, t.y));
	//convert world position back to texture position:
	endPosition = endPosition / volScale;
	return endPosition;
}
vec4 applyClip (vec3 dir, inout vec4 samplePos, inout float len, inout bool isClip) {
	float cdot = dot(dir,clipPlane.xyz);
	isClip = false;
	if  ((clipPlane.a > 1.0) || (cdot == 0.0)) return samplePos;
	bool frontface = (cdot > 0.0);
	float clipThick = 2.0;
	float dis = (-clipPlane.a - dot(clipPlane.xyz, samplePos.xyz-0.5)) / cdot;
	float  disBackFace = (-(clipPlane.a-clipThick) - dot(clipPlane.xyz, samplePos.xyz-0.5)) / cdot;
	if (((frontface) && (dis >= len)) || ((!frontface) && (dis <= 0.0))) {
		samplePos.a = len + 1.0;
		return samplePos;
	}
	if (frontface) {
		dis = max(0.0, dis);
		samplePos = vec4(samplePos.xyz+dir * dis, dis);
		if (dis > 0.0) isClip = true;
		len = min(disBackFace, len);
	}
	if (!frontface) {
		len = min(dis, len);
		disBackFace = max(0.0, disBackFace);
		if (len == dis) isClip = true;
		samplePos = vec4(samplePos.xyz+dir * disBackFace, disBackFace);
	}
	return samplePos;
}
float frac2ndc(vec3 frac) {
//https://stackoverflow.com/questions/7777913/how-to-render-depth-linearly-in-modern-opengl-with-gl-fragcoord-z-in-fragment-sh
	vec4 pos = vec4(frac.xyz, 1.0); //fraction
	vec4 dim = vec4(vec3(textureSize(volume, 0)), 1.0);
	pos = pos * dim;
	vec4 shim = vec4(-0.5, -0.5, -0.5, 0.0);
	pos += shim;
	vec4 mm = transpose(matRAS) * pos;
	float z_ndc = (mvpMtx * vec4(mm.xyz, 1.0)).z;
	return (z_ndc + 1.0) / 2.0;
}` + kDrawFunc;

export var fragRenderShaderMIP =
  `#version 300 es
#line 14
precision highp int;
precision highp float;
uniform vec3 rayDir;
uniform vec3 texVox;
uniform vec3 volScale;
uniform vec4 clipPlane;
uniform highp sampler3D volume, overlay;
uniform float overlays;
uniform float backOpacity;
uniform mat4 mvpMtx;
uniform mat4 matRAS;
uniform vec4 clipPlaneColor;
uniform float drawOpacity;
uniform highp sampler3D drawing;
uniform highp sampler2D colormap;
in vec3 vColor;
out vec4 fColor;
` +
  kRenderFunc +
  `void main() {
	fColor = vec4(0.0,0.0,0.0,0.0);
	//fColor = vec4(vColor.rgb, 1.0); return;
	vec3 start = vColor;
	gl_FragDepth = 0.0;
	vec3 backPosition = GetBackPosition(start);
	// fColor = vec4(backPosition, 1.0); return;
	vec3 dir = backPosition - start;
	float len = length(dir);
	float lenVox = length((texVox * start) - (texVox * backPosition));
	if ((lenVox < 0.5) || (len > 3.0)) { //length limit for parallel rays
		return;
	}
	float sliceSize = len / lenVox; //e.g. if ray length is 1.0 and traverses 50 voxels, each voxel is 0.02 in unit cube
	float stepSize = sliceSize; //quality: larger step is faster traversal, but fewer samples
	float opacityCorrection = stepSize/sliceSize;
	dir = normalize(dir);
	vec4 deltaDir = vec4(dir.xyz * stepSize, stepSize);
	vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	float lenNoClip = len;
	bool isClip = false;
	vec4 clipPos = applyClip(dir, samplePos, len, isClip);
	//if ((clipPos.a != samplePos.a) && (len < 3.0)) {
	//start: OPTIONAL fast pass: rapid traversal until first hit
	float stepSizeFast = sliceSize * 1.9;
	vec4 deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(volume, samplePos.xyz).a;
		if (val > 0.01) break;
		samplePos += deltaDirFast; //advance ray position
	}
	if ((samplePos.a >= len) && (overlays < 1.0)) {
		if (isClip)
			fColor += clipPlaneColor;
		return;
	}
	fColor = vec4(1.0, 1.0, 1.0, 1.0);
	//gl_FragDepth = frac2ndc(samplePos.xyz); //crude due to fast pass resolution
	samplePos -= deltaDirFast;
	if (samplePos.a < 0.0)
		vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	//end: fast pass
	vec4 colAcc = vec4(0.0,0.0,0.0,0.0);
	vec4 firstHit = vec4(0.0,0.0,0.0,2.0 * lenNoClip);
	const float earlyTermination = 0.95;
	float backNearest = len; //assume no hit
	float ran = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
	samplePos += deltaDir * ran; //jitter ray
	while (samplePos.a <= len) {
		vec4 colorSample = texture(volume, samplePos.xyz);
		samplePos += deltaDir; //advance ray position
		if (colorSample.a >= 0.01) {
			if (firstHit.a > lenNoClip)
				firstHit = samplePos;
			backNearest = min(backNearest, samplePos.a);
			if (colorSample.a > colAcc.a) //ties generate errors for TT_desai_dd_mpm
				colAcc = vec4(colorSample.rgb, colorSample.a+0.00001);
		}
	}
	if (firstHit.a < len)
		gl_FragDepth = frac2ndc(firstHit.xyz);
	colAcc.a *= backOpacity;
	fColor = colAcc;
	if (isClip) //CR
		fColor.rgb = mix(fColor.rgb, clipPlaneColor.rgb, clipPlaneColor.a * 0.15);
	if (overlays < 1.0) return;
	//overlay pass
	len = lenNoClip;
	samplePos = vec4(start.xyz, 0.0); //ray position
	//start: OPTIONAL fast pass: rapid traversal until first hit
	stepSizeFast = sliceSize * 1.9;
	deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(overlay, samplePos.xyz).a;
		if (val > 0.01) break;
		samplePos += deltaDirFast; //advance ray position
	}
	if (samplePos.a >= len) {
		if (isClip && (fColor.a == 0.0))
			fColor += clipPlaneColor;
		return;
	}
	samplePos -= deltaDirFast;
	if (samplePos.a < 0.0)
		vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	//end: fast pass
	float overFarthest = len;
	colAcc = vec4(0.0, 0.0, 0.0, 0.0);
	samplePos += deltaDir * ran; //jitter ray
	vec4 overFirstHit = vec4(0.0,0.0,0.0,2.0 * len);
	while (samplePos.a <= len) {
		vec4 colorSample = texture(overlay, samplePos.xyz);
		samplePos += deltaDir; //advance ray position
		if (colorSample.a >= 0.01) {
			if (overFirstHit.a > len)
				overFirstHit = samplePos;
			colorSample.a = 1.0-pow((1.0 - colorSample.a), opacityCorrection);
			colorSample.rgb *= colorSample.a;
			colAcc= (1.0 - colAcc.a) * colorSample + colAcc;
			overFarthest = samplePos.a;
			if ( colAcc.a > earlyTermination )
				break;
		}
	}
	if (overFirstHit.a < firstHit.a)
	//if (overFirstHit.a < len)
		gl_FragDepth = frac2ndc(overFirstHit.xyz);
	float overMix = colAcc.a;
	float overlayDepth = 0.3;
	if (fColor.a <= 0.0)
			overMix = 1.0;
	else if (((overFarthest) > backNearest)) {
		float dx = (overFarthest - backNearest)/1.73;
		dx = fColor.a * pow(dx, overlayDepth);
		overMix *= 1.0 - dx;
	}
	fColor.rgb = mix(fColor.rgb, colAcc.rgb, overMix);
	fColor.a = max(fColor.a, colAcc.a);
}`;

export var fragRenderShader =
  `#version 300 es
#line 14
precision highp int;
precision highp float;
uniform vec3 rayDir;
uniform vec3 texVox;
uniform int backgroundMasksOverlays;
uniform vec3 volScale;
uniform vec4 clipPlane;
uniform highp sampler3D volume, overlay;
uniform float overlays;
uniform float backOpacity;
uniform mat4 mvpMtx;
uniform mat4 matRAS;
uniform vec4 clipPlaneColor;
uniform float drawOpacity;
uniform highp sampler3D drawing;
uniform highp sampler2D colormap;
in vec3 vColor;
out vec4 fColor;
` +
  kRenderFunc +
  `void main() {
	if (fColor.x > 2.0) {
		fColor = vec4(1.0, 0.0, 0.0, 0.5);
		return;
	}
	fColor = vec4(0.0,0.0,0.0,0.0);
	vec4 clipPlaneColorX = clipPlaneColor;
	//if (clipPlaneColor.a < 0.0)
	//	clipPlaneColorX.a = - 1.0;
	bool isColorPlaneInVolume = false;
	if (clipPlaneColorX.a < 0.0) {
		isColorPlaneInVolume = true;
		clipPlaneColorX.a = 0.0;
	}
	//fColor = vec4(vColor.rgb, 1.0); return;
	vec3 start = vColor;
	gl_FragDepth = 0.0;
	vec3 backPosition = GetBackPosition(start);
	// fColor = vec4(backPosition, 1.0); return;
	vec3 dir = backPosition - start;
	float len = length(dir);
	float lenVox = length((texVox * start) - (texVox * backPosition));
	if ((lenVox < 0.5) || (len > 3.0)) { //length limit for parallel rays
		return;
	}
	float sliceSize = len / lenVox; //e.g. if ray length is 1.0 and traverses 50 voxels, each voxel is 0.02 in unit cube
	float stepSize = sliceSize; //quality: larger step is faster traversal, but fewer samples
	float opacityCorrection = stepSize/sliceSize;
	dir = normalize(dir);
	vec4 deltaDir = vec4(dir.xyz * stepSize, stepSize);
	vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	float lenNoClip = len;
	bool isClip = false;
	vec4 clipPos = applyClip(dir, samplePos, len, isClip);
	//if ((clipPos.a != samplePos.a) && (len < 3.0)) {
	//start: OPTIONAL fast pass: rapid traversal until first hit
	float stepSizeFast = sliceSize * 1.9;
	vec4 deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(volume, samplePos.xyz).a;
		if (val > 0.01)
			break;
		samplePos += deltaDirFast; //advance ray position
	}
	if ((samplePos.a >= len) && (((overlays < 1.0) && (drawOpacity <= 0.0) ) || (backgroundMasksOverlays > 0)))  {
		if (isClip)
			fColor += clipPlaneColorX;
		return;
	}
	fColor = vec4(1.0, 1.0, 1.0, 1.0);
	//gl_FragDepth = frac2ndc(samplePos.xyz); //crude due to fast pass resolution
	samplePos -= deltaDirFast;
	if (samplePos.a < 0.0)
		vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	//end: fast pass
	vec4 colAcc = vec4(0.0,0.0,0.0,0.0);
	vec4 firstHit = vec4(0.0,0.0,0.0,2.0 * lenNoClip);
	const float earlyTermination = 0.95;
	float backNearest = len; //assume no hit
	float ran = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
	samplePos += deltaDir * ran; //jitter ray
	while (samplePos.a <= len) {
		vec4 colorSample = texture(volume, samplePos.xyz);
		samplePos += deltaDir; //advance ray position
		if (colorSample.a >= 0.01) {
			if (firstHit.a > lenNoClip)
				firstHit = samplePos;
			backNearest = min(backNearest, samplePos.a);
			colorSample.a = 1.0-pow((1.0 - colorSample.a), opacityCorrection);
			colorSample.rgb *= colorSample.a;
			colAcc= (1.0 - colAcc.a) * colorSample + colAcc;
			if ( colAcc.a > earlyTermination )
				break;
		}
	}
	if (firstHit.a < len)
		gl_FragDepth = frac2ndc(firstHit.xyz);
	colAcc.a = (colAcc.a / earlyTermination) * backOpacity;
	fColor = colAcc;
	//if (isClip) //CR
	if ((isColorPlaneInVolume) && (clipPos.a != samplePos.a) && (abs(firstHit.a - clipPos.a) < deltaDir.a))
		fColor.rgb = mix(fColor.rgb, clipPlaneColorX.rgb, abs(clipPlaneColor.a));
		//fColor.rgb = mix(fColor.rgb, clipPlaneColorX.rgb, clipPlaneColorX.a * 0.65);
	if ((overlays < 1.0) && (drawOpacity <= 0.0))
		return;
	//overlay pass
	len = lenNoClip;
	samplePos = vec4(start.xyz, 0.0); //ray position
	//start: OPTIONAL fast pass: rapid traversal until first hit
	stepSizeFast = sliceSize * 1.0;
	deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(overlay, samplePos.xyz).a;
		if (drawOpacity > 0.0)
			val = max(val, texture(drawing, samplePos.xyz).r);
		if (val > 0.001)
			break;
		samplePos += deltaDirFast; //advance ray position
	}
	if (samplePos.a >= len) {
		if (isClip && (fColor.a == 0.0))
				fColor += clipPlaneColorX;
			return;
	}
	samplePos -= deltaDirFast;
	if (samplePos.a < 0.0)
		vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	//end: fast pass
	float overFarthest = len;
	colAcc = vec4(0.0, 0.0, 0.0, 0.0);

	samplePos += deltaDir * ran; //jitter ray
	vec4 overFirstHit = vec4(0.0,0.0,0.0,2.0 * len);
	if (backgroundMasksOverlays > 0)
		samplePos = firstHit;
	while (samplePos.a <= len) {
		vec4 colorSample = texture(overlay, samplePos.xyz);
		if ((colorSample.a < 0.01) && (drawOpacity > 0.0)) {
			float val = texture(drawing, samplePos.xyz).r;
			colorSample = drawColor(val);
		}
		samplePos += deltaDir; //advance ray position
		if (colorSample.a >= 0.01) {
			if (overFirstHit.a > len)
				overFirstHit = samplePos;
			colorSample.a = 1.0-pow((1.0 - colorSample.a), opacityCorrection);
			colorSample.rgb *= colorSample.a;
			colAcc= (1.0 - colAcc.a) * colorSample + colAcc;
			overFarthest = samplePos.a;
			if ( colAcc.a > earlyTermination )
				break;
		}
	}
	//if (samplePos.a >= len) {
	if (colAcc.a <= 0.0) {
		if (isClip && (fColor.a == 0.0))
			fColor += clipPlaneColorX;
		return;
	}

	//if (overFirstHit.a < len)
	gl_FragDepth = frac2ndc(overFirstHit.xyz);
	float overMix = colAcc.a;
	float overlayDepth = 0.3;
	if (fColor.a <= 0.0)
		overMix = 1.0;
	else if (((overFarthest) > backNearest)) {
		float dx = (overFarthest - backNearest)/1.73;
		dx = fColor.a * pow(dx, overlayDepth);
		overMix *= 1.0 - dx;
	}
	fColor.rgb = mix(fColor.rgb, colAcc.rgb, overMix);
	fColor.a = max(fColor.a, colAcc.a);
}`;

export var vertSliceMMShader = `#version 300 es
#line 4
layout(location=0) in vec3 pos;
uniform int axCorSag;
uniform mat4 mvpMtx;
uniform mat4 frac2mm;
uniform float slice;
out vec3 texPos;
void main(void) {
	texPos = vec3(pos.x, pos.y, slice);
	if (axCorSag > 1)
		texPos = vec3(slice, pos.x, pos.y);
	else if (axCorSag > 0)
		texPos = vec3(pos.x, slice, pos.y);
	vec4 mm = frac2mm * vec4(texPos, 1.0);
	gl_Position = mvpMtx * mm;
}`;

export var fragSliceMMShader =
  `#version 300 es
#line 228
precision highp int;
precision highp float;
uniform highp sampler3D volume, overlay;
uniform int backgroundMasksOverlays;
uniform float overlayOutlineWidth;
uniform int axCorSag;
uniform float overlays;
uniform float opacity;
uniform float drawOpacity;
uniform bool isAlphaClipDark;
uniform highp sampler3D drawing;
uniform highp sampler2D colormap;
in vec3 texPos;
out vec4 color;` +
  kDrawFunc +
  `void main() {
	//color = vec4(1.0, 0.0, 1.0, 1.0);return;
	vec4 background = texture(volume, texPos);
	color = vec4(background.rgb, opacity);
	if ((isAlphaClipDark) && (background.a == 0.0)) color.a = 0.0; //FSLeyes clipping range
	vec4 ocolor = vec4(0.0);
	if (overlays > 0.0) {
		ocolor = texture(overlay, texPos);
		//dFdx for "boxing" issue 435 has aliasing on some implementations (coarse vs fine)
		//however, this only identifies 50% of the edges due to aliasing effects
		// http://www.aclockworkberry.com/shader-derivative-functions/
		// https://bgolus.medium.com/distinctive-derivative-differences-cce38d36797b
		//if ((ocolor.a >= 1.0) && ((dFdx(ocolor.a) != 0.0) || (dFdy(ocolor.a) != 0.0)  ))
		//	ocolor.rbg = vec3(0.0, 0.0, 0.0);
		if ((overlayOutlineWidth > 0.0) && (ocolor.a >= 1.0)) { //check voxel neighbors for edge
			vec3 vx = (overlayOutlineWidth ) / vec3(textureSize(overlay, 0));
			vec3 vxR = vec3(texPos.x+vx.x, texPos.y, texPos.z);
			vec3 vxL = vec3(texPos.x-vx.x, texPos.y, texPos.z);
			vec3 vxA = vec3(texPos.x, texPos.y+vx.y, texPos.z);
			vec3 vxP = vec3(texPos.x, texPos.y-vx.y, texPos.z);
			vec3 vxS = vec3(texPos.x, texPos.y, texPos.z+vx.z);
			vec3 vxI = vec3(texPos.x, texPos.y, texPos.z-vx.z);
			float a = 1.0;
			if (axCorSag != 2) {
				a = min(a, texture(overlay, vxR).a);
				a = min(a, texture(overlay, vxL).a);
			}
			if (axCorSag != 1) {
				a = min(a, texture(overlay, vxA).a);
				a = min(a, texture(overlay, vxP).a);
			}
			if (axCorSag != 0) {
				a = min(a, texture(overlay, vxS).a);
				a = min(a, texture(overlay, vxI).a);
			}
			if (a < 1.0)
				ocolor.rbg = vec3(0.0, 0.0, 0.0);
		}
	}
	vec4 dcolor = drawColor(texture(drawing, texPos).r);
	if (dcolor.a > 0.0) {
		color.rgb = mix(color.rgb, dcolor.rgb, dcolor.a);
		color.a = max(drawOpacity, color.a);
	}
	if ((backgroundMasksOverlays > 0) && (background.a == 0.0))
		return;
	float a = color.a + ocolor.a * (1.0 - color.a); // premultiplied alpha
	if (a == 0.0) return;
	color.rgb = mix(color.rgb, ocolor.rgb, ocolor.a / a);
	color.a = a;
}`;

export var fragRectShader = `#version 300 es
#line 189
precision highp int;
precision highp float;
uniform vec4 lineColor;
out vec4 color;
void main() {
	color = lineColor;
}`;

export var vertColorbarShader = `#version 300 es
#line 200
layout(location=0) in vec3 pos;
uniform vec2 canvasWidthHeight;
uniform vec4 leftTopWidthHeight;
out vec2 vColor;
void main(void) {
	//convert pixel x,y space 1..canvasWidth,1..canvasHeight to WebGL 1..-1,-1..1
	vec2 frac;
	frac.x = (leftTopWidthHeight.x + (pos.x * leftTopWidthHeight.z)) / canvasWidthHeight.x; //0..1
	frac.y = 1.0 - ((leftTopWidthHeight.y + ((1.0 - pos.y) * leftTopWidthHeight.w)) / canvasWidthHeight.y); //1..0
	frac = (frac * 2.0) - 1.0;
	gl_Position = vec4(frac, 0.0, 1.0);
	vColor = pos.xy;
}`;

export var fragColorbarShader = `#version 300 es
#line 217
precision highp int;
precision highp float;
uniform highp sampler2D colormap;
uniform float layer;
in vec2 vColor;
out vec4 color;
void main() {
	float nlayer = float(textureSize(colormap, 0).y);
	float fmap = (0.5 + layer) / nlayer;
	color = vec4(texture(colormap, vec2(vColor.x, fmap)).rgb, 1.0);
}`;

export var vertRectShader = `#version 300 es
#line 229
layout(location=0) in vec3 pos;
uniform vec2 canvasWidthHeight;
uniform vec4 leftTopWidthHeight;
void main(void) {
	//convert pixel x,y space 1..canvasWidth,1..canvasHeight to WebGL 1..-1,-1..1
	vec2 frac;
	frac.x = (leftTopWidthHeight.x + (pos.x * leftTopWidthHeight.z)) / canvasWidthHeight.x; //0..1
	frac.y = 1.0 - ((leftTopWidthHeight.y + ((1.0 - pos.y) * leftTopWidthHeight.w)) / canvasWidthHeight.y); //1..0
	frac = (frac * 2.0) - 1.0;
	gl_Position = vec4(frac, 0.0, 1.0);
}`;

export var vertLineShader = `#version 300 es
#line 229
layout(location=0) in vec3 pos;
uniform vec2 canvasWidthHeight;
uniform float thickness;
uniform vec4 startXYendXY;
void main(void) {
	vec2 posXY = mix(startXYendXY.xy, startXYendXY.zw, pos.x);
	vec2 dir = normalize(startXYendXY.xy - startXYendXY.zw);
	posXY += vec2(-dir.y, dir.x) * thickness * (pos.y - 0.5);
	posXY.x = (posXY.x) / canvasWidthHeight.x; //0..1
	posXY.y = 1.0 - (posXY.y / canvasWidthHeight.y); //1..0
	gl_Position = vec4((posXY * 2.0) - 1.0, 0.0, 1.0);
}`;

export var vertBmpShader = `#version 300 es
#line 229
layout(location=0) in vec3 pos;
uniform vec2 canvasWidthHeight;
uniform vec4 leftTopWidthHeight;
out vec2 vUV;
void main(void) {
	//convert pixel x,y space 1..canvasWidth,1..canvasHeight to WebGL 1..-1,-1..1
	vec2 frac;
	frac.x = (leftTopWidthHeight.x + (pos.x * leftTopWidthHeight.z)) / canvasWidthHeight.x; //0..1
	frac.y = 1.0 - ((leftTopWidthHeight.y + ((1.0 - pos.y) * leftTopWidthHeight.w)) / canvasWidthHeight.y); //1..0
	frac = (frac * 2.0) - 1.0;
	gl_Position = vec4(frac, 0.0, 1.0);
	vUV = vec2(pos.x, 1.0 - pos.y);
}`;

export var fragBmpShader = `#version 300 es
#line 262
precision highp int;
precision highp float;
uniform highp sampler2D bmpTexture;
in vec2 vUV;
out vec4 color;
void main() {
	color = texture(bmpTexture, vUV);
}`;

export var vertFontShader = `#version 300 es
#line 244
layout(location=0) in vec3 pos;
uniform vec2 canvasWidthHeight;
uniform vec4 leftTopWidthHeight;
uniform vec4 uvLeftTopWidthHeight;
out vec2 vUV;
void main(void) {
	//convert pixel x,y space 1..canvasWidth,1..canvasHeight to WebGL 1..-1,-1..1
	vec2 frac;
	frac.x = (leftTopWidthHeight.x + (pos.x * leftTopWidthHeight.z)) / canvasWidthHeight.x; //0..1
	frac.y = 1.0 - ((leftTopWidthHeight.y + ((1.0 - pos.y) * leftTopWidthHeight.w)) / canvasWidthHeight.y); //1..0
	frac = (frac * 2.0) - 1.0;
	gl_Position = vec4(frac, 0.0, 1.0);
	vUV = vec2(uvLeftTopWidthHeight.x + (pos.x * uvLeftTopWidthHeight.z), uvLeftTopWidthHeight.y  + ((1.0 - pos.y) * uvLeftTopWidthHeight.w) );
}`;

export var fragFontShader = `#version 300 es
#line 262
precision highp int;
precision highp float;
uniform highp sampler2D fontTexture;
uniform vec4 fontColor;
uniform float screenPxRange;
in vec2 vUV;
out vec4 color;
float median(float r, float g, float b) {
	return max(min(r, g), min(max(r, g), b));
}
void main() {
	vec3 msd = texture(fontTexture, vUV).rgb;
	float sd = median(msd.r, msd.g, msd.b);
	float screenPxDistance = screenPxRange*(sd - 0.5);
	float opacity = clamp(screenPxDistance + 0.5, 0.0, 1.0);
	color = vec4(fontColor.rgb , fontColor.a * opacity);
}`;

export var vertOrientShader = `#version 300 es
#line 283
precision highp int;
precision highp float;
in vec3 vPos;
out vec2 TexCoord;
void main() {
	TexCoord = vPos.xy;
	gl_Position = vec4( (vPos.xy-vec2(0.5,0.5)) * 2.0, 0.0, 1.0);
}`;

export var fragOrientShaderU = `#version 300 es
uniform highp usampler3D intensityVol;
`;

export var fragOrientShaderI = `#version 300 es
uniform highp isampler3D intensityVol;
`;

export var fragOrientShaderF = `#version 300 es
uniform highp sampler3D intensityVol;
`;

//uniform vec2 canvasWidthHeight;
export var fragOrientShaderAtlas = `#line 309
precision highp int;
precision highp float;
in vec2 TexCoord;
out vec4 FragColor;
uniform float coordZ;
uniform float layer;
//uniform float numLayers;
uniform highp sampler2D colormap;
uniform lowp sampler3D blend3D;
uniform float opacity;
uniform vec3 xyzFrac;
uniform mat4 mtx;
void main(void) {
	vec4 vx = vec4(TexCoord.x, TexCoord.y, coordZ, 1.0) * mtx;
	uint idx = texture(intensityVol, vx.xyz).r;
	FragColor = vec4(0.0, 0.0, 0.0, 0.0);
	if (idx == uint(0))
		return;
	if (xyzFrac.x > 0.0) { //outline
		vx = vec4(TexCoord.x+xyzFrac.x, TexCoord.y, coordZ, 1.0) * mtx;
		uint R = texture(intensityVol, vx.xyz).r;
		vx = vec4(TexCoord.x-xyzFrac.x, TexCoord.y, coordZ, 1.0) * mtx;
		uint L = texture(intensityVol, vx.xyz).r;
		vx = vec4(TexCoord.x, TexCoord.y+xyzFrac.y, coordZ, 1.0) * mtx;
		uint A = texture(intensityVol, vx.xyz).r;
		vx = vec4(TexCoord.x, TexCoord.y-xyzFrac.y, coordZ, 1.0) * mtx;
		uint P = texture(intensityVol, vx.xyz).r;
		vx = vec4(TexCoord.x, TexCoord.y, coordZ+xyzFrac.z, 1.0) * mtx;
		uint S = texture(intensityVol, vx.xyz).r;
		vx = vec4(TexCoord.x, TexCoord.y, coordZ-xyzFrac.z, 1.0) * mtx;
		uint I = texture(intensityVol, vx.xyz).r;
		if ((idx == R) && (idx == L) && (idx == A) && (idx == P) && (idx == S) && (idx == I))
			return;
	}
	idx = ((idx - uint(1)) % uint(100))+uint(1);
	float fx = (float(idx)+0.5) / 256.0;
	float nlayer = float(textureSize(colormap, 0).y) * 0.5; //0.5 as both each layer has positive and negative color slot
	float y = (2.0 * layer + 1.0)/(4.0 * nlayer);
	//float y = (2.0 * layer + 1.0)/(4.0 * numLayers);
	FragColor = texture(colormap, vec2(fx, y)).rgba;
	//FragColor.a *= opacity;
	FragColor.a = opacity;
	return;

	if (layer < 2.0) return;
	//vec2 texXY = TexCoord.xy*0.5 +vec2(0.5,0.5);
	//vec4 prevColor = texture(blend3D, vec3(texXY, coordZ));
	vec4 prevColor = texture(blend3D, vec3(TexCoord.xy, coordZ));
	// https://en.wikipedia.org/wiki/Alpha_compositing
	float aout = FragColor.a + (1.0 - FragColor.a) * prevColor.a;
	if (aout <= 0.0) return;
	FragColor.rgb = ((FragColor.rgb * FragColor.a) + (prevColor.rgb * prevColor.a * (1.0 - FragColor.a))) / aout;
	FragColor.a = aout;
}`;

export var fragOrientShader = `#line 309
precision highp int;
precision highp float;
in vec2 TexCoord;
out vec4 FragColor;
uniform float coordZ;
uniform float layer;
uniform float scl_slope;
uniform float scl_inter;
uniform float cal_max;
uniform float cal_min;
uniform float cal_maxNeg;
uniform float cal_minNeg;
uniform bool isAlphaThreshold;
uniform highp sampler2D colormap;
uniform lowp sampler3D blend3D;
uniform int modulation;
uniform highp sampler3D modulationVol;
uniform float opacity;
uniform mat4 mtx;
void main(void) {
	vec4 vx = vec4(TexCoord.xy, coordZ, 1.0) * mtx;
	if ((vx.x < 0.0) || (vx.x > 1.0) || (vx.y < 0.0) || (vx.y > 1.0) || (vx.z < 0.0) || (vx.z > 1.0)) {
		//set transparent if out of range
		//https://webglfundamentals.org/webgl/webgl-3d-textures-repeat-clamp.html
		FragColor = vec4(0.0, 0.0, 0.0, 0.0);
		return;
	}
	float f = (scl_slope * float(texture(intensityVol, vx.xyz).r)) + scl_inter;
	float mn = cal_min;
	float mx = cal_max;
	if (isAlphaThreshold)
		mn = 0.0;
	float r = max(0.00001, abs(mx - mn));
	mn = min(mn, mx);
	float txl = mix(0.0, 1.0, (f - mn) / r);
	//https://stackoverflow.com/questions/5879403/opengl-texture-coordinates-in-pixel-space
	float nlayer = float(textureSize(colormap, 0).y);
	float y = (layer + 0.5)/nlayer;
	//if (!isnan(cal_minNeg)) //Radeon drivers have issues NaN
	if (cal_minNeg < cal_maxNeg)
		y = (layer + 1.5)/nlayer;
	FragColor = texture(colormap, vec2(txl, y)).rgba;
	//negative colors
	mn = cal_minNeg;
	mx = cal_maxNeg;
	if (isAlphaThreshold)
		mx = 0.0;
	//if ((!isnan(cal_minNeg)) && ( f < mx)) {
	if ((cal_minNeg < cal_maxNeg) && ( f < mx)) {
		r = max(0.00001, abs(mx - mn));
		mn = min(mn, mx);
		txl = 1.0 - mix(0.0, 1.0, (f - mn) / r);
		y = (layer + 0.5)/nlayer;
		FragColor = texture(colormap, vec2(txl, y));
	}
	if (layer > 0.7)
		FragColor.a = step(0.00001, FragColor.a);
	//if (modulation > 10)
	//	FragColor.a *= texture(modulationVol, vx.xyz).r;
	//	FragColor.rgb *= texture(modulationVol, vx.xyz).r;
	if (isAlphaThreshold) {
		if ((cal_minNeg != cal_maxNeg) && ( f < 0.0) && (f > cal_maxNeg))
			FragColor.a = pow(-f / -cal_maxNeg, 2.0);
		else if ((f > 0.0) && (cal_min > 0.0))
			FragColor.a *= pow(f / cal_min, 2.0); //issue435:  A = (V/X)**2
		//FragColor.g = 0.0;
	}
	if (modulation == 1) {
		FragColor.rgb *= texture(modulationVol, vx.xyz).r;
	} else if (modulation == 2) {
		FragColor.a = texture(modulationVol, vx.xyz).r;
	}
	FragColor.a *= opacity;
	if (layer < 1.0) return;
	vec4 prevColor = texture(blend3D, vec3(TexCoord.xy, coordZ));
	// https://en.wikipedia.org/wiki/Alpha_compositing
	float aout = FragColor.a + (1.0 - FragColor.a) * prevColor.a;
	if (aout <= 0.0) return;
	FragColor.rgb = ((FragColor.rgb * FragColor.a) + (prevColor.rgb * prevColor.a * (1.0 - FragColor.a))) / aout;
	FragColor.a = aout;
}`;

export var fragRGBOrientShader = `#line 309
precision highp int;
precision highp float;
in vec2 TexCoord;
out vec4 FragColor;
uniform float coordZ;
uniform float layer;
uniform float scl_slope;
uniform float scl_inter;
uniform float cal_max;
uniform float cal_min;
uniform highp sampler2D colormap;
uniform lowp sampler3D blend3D;
uniform float opacity;
uniform mat4 mtx;
uniform bool hasAlpha;
uniform int modulation;
uniform highp sampler3D modulationVol;
void main(void) {
	vec4 vx = vec4(TexCoord.xy, coordZ, 1.0) * mtx;
	uvec4 aColor = texture(intensityVol, vx.xyz);
	FragColor = vec4(float(aColor.r) / 255.0, float(aColor.g) / 255.0, float(aColor.b) / 255.0, float(aColor.a) / 255.0);
	if (modulation == 1)
		FragColor.rgb *= texture(modulationVol, vx.xyz).r;
	if (!hasAlpha) {
		FragColor.a = (FragColor.r * 0.21 + FragColor.g * 0.72 + FragColor.b * 0.07);
		//next line: we could binarize alpha, but see rendering of visible human
		//FragColor.a = step(0.01, FragColor.a);
	}
	if (modulation == 2)
		FragColor.a = texture(modulationVol, vx.xyz).r;
	FragColor.a *= opacity;
}`;

export var vertGrowCutShader = `#version 300 es
#line 283
precision highp int;
precision highp float;
in vec3 vPos;
out vec2 TexCoord;
void main() {
	TexCoord = vPos.xy;
	gl_Position = vec4((vPos.x - 0.5) * 2.0, (vPos.y - 0.5) * 2.0, 0.0, 1.0);
}`;

//https://github.com/pieper/step/blob/master/src/growcut.js
// Steve Pieper 2022: Apache License 2.0
export var fragGrowCutShader = `#version 300 es
#line 742
	precision highp float;
	precision highp int;
	precision highp isampler3D;
	layout(location = 0) out int label;
	layout(location = 1) out int strength;
	in vec2 TexCoord;
	uniform int finalPass;
	uniform float coordZ;
	uniform lowp sampler3D in3D;
	uniform highp isampler3D inputTexture0; // background
	uniform highp isampler3D inputTexture1; // label
	uniform highp isampler3D inputTexture2; // strength
void main(void) {
	vec3 interpolatedTextureCoordinate = vec3(TexCoord.xy, coordZ);
	ivec3 size = textureSize(inputTexture0, 0);
	ivec3 texelIndex = ivec3(floor(interpolatedTextureCoordinate * vec3(size)));
	int background = texelFetch(inputTexture0, texelIndex, 0).r;
	label = texelFetch(inputTexture1, texelIndex, 0).r;
	strength = texelFetch(inputTexture2, texelIndex, 0).r;
	for (int k = -1; k <= 1; k++) {
		for (int j = -1; j <= 1; j++) {
			for (int i = -1; i <= 1; i++) {
				if (i != 0 && j != 0 && k != 0) {
					ivec3 neighborIndex = texelIndex + ivec3(i,j,k);
					int neighborBackground = texelFetch(inputTexture0, neighborIndex, 0).r;
					int neighborStrength = texelFetch(inputTexture2, neighborIndex, 0).r;
					int strengthCost = abs(neighborBackground - background);
					int takeoverStrength = neighborStrength - strengthCost;
					if (takeoverStrength > strength) {
						strength = takeoverStrength;
						label = texelFetch(inputTexture1, neighborIndex, 0).r;
					}
				}
			}
		}
	}
	if (finalPass < 1)
		return;
	int ok = 1;
	ivec4 labelCount = ivec4(0,0,0,0);
	for (int k = -1; k <= 1; k++)
		for (int j = -1; j <= 1; j++)
			for (int i = -1; i <= 1; i++) {
				ivec3 neighborIndex = texelIndex + ivec3(i,j,k);
				int ilabel = texelFetch(inputTexture1, neighborIndex, 0).r;
				if ((ilabel < 0) || (ilabel > 3))
					ok = 0;
				else
					labelCount[ilabel]++;
			}
	if (ok != 1) {
		return;
	}
	int maxIdx = 0;
	for (int i = 1; i < 4; i++) {
		if (labelCount[i] > labelCount[maxIdx])
			maxIdx = i;
	}
	label = maxIdx;
}`; //inputTexture0

export var vertSurfaceShader = `#version 300 es
layout(location=0) in vec3 pos;
uniform mat4 mvpMtx;
void main(void) {
	gl_Position = mvpMtx * vec4(pos, 1.0);
}`;

export var fragSurfaceShader = `#version 300 es
precision highp int;
precision highp float;
uniform vec4 surfaceColor;
out vec4 color;
void main() {
	color = surfaceColor;
}`;

export var vertFiberShader = `#version 300 es
layout(location=0) in vec3 pos;
layout(location=1) in vec4 clr;
out vec4 vClr;
uniform mat4 mvpMtx;
void main(void) {
	gl_Position = mvpMtx * vec4(pos, 1.0);
	vClr = clr;
}`;

export var fragFiberShader = `#version 300 es
precision highp int;
precision highp float;
in vec4 vClr;
out vec4 color;
uniform float opacity;
void main() {
	//color = vClr;
	color = vec4(vClr.rgb, opacity);
}`;

export var vertMeshShader = `#version 300 es
layout(location=0) in vec3 pos;
layout(location=1) in vec4 norm;
layout(location=2) in vec4 clr;
uniform mat4 mvpMtx;
//uniform mat4 modelMtx;
uniform mat4 normMtx;
out vec4 vClr;
out vec3 vN;
void main(void) {
	vec3 lightPosition = vec3(0.0, 0.0, -10.0);
	gl_Position = mvpMtx * vec4(pos, 1.0);
	vN = normalize((normMtx * vec4(norm.xyz,1.0)).xyz);
	//vV = -vec3(modelMtx*vec4(pos,1.0));
	vClr = clr;
}`;

//report depth for fragment
// https://github.com/rii-mango/Papaya/blob/782a19341af77a510d674c777b6da46afb8c65f1/src/js/viewer/screensurface.js#L89
export var fragMeshDepthShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
out vec4 color;
vec4 packFloatToVec4i(const float value) {
	const vec4 bitSh = vec4(256.0*256.0*256.0, 256.0*256.0, 256.0, 1.0);
	const vec4 bitMsk = vec4(0.0, 1.0/256.0, 1.0/256.0, 1.0/256.0);
	vec4 res = fract(value * bitSh);
	res -= res.xxyz * bitMsk;
	return res;
}
void main() {
	color = packFloatToVec4i(gl_FragCoord.z);
}`;

//ToonShader https://prideout.net/blog/old/blog/index.html@tag=toon-shader.html
export var fragMeshToonShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN;
out vec4 color;
float stepmix(float edge0, float edge1, float E, float x){
	float T = clamp(0.5 * (x - edge0 + E) / E, 0.0, 1.0);
	return mix(edge0, edge1, T);
}
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0);
	float ambient = 0.3;
	float diffuse = 0.6;
	float specular = 0.5;
	float shininess = 50.0;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float df = max(0.0, dot(n, l));
	float sf = pow(max(dot(reflect(l, n), r), 0.0), shininess);
	const float A = 0.1;
	const float B = 0.3;
	const float C = 0.6;
	const float D = 1.0;
	float E = fwidth(df);
	if (df > A - E && df < A + E) df = stepmix(A, B, E, df);
	else if (df > B - E && df < B + E) df = stepmix(B, C, E, df);
	else if (df > C - E && df < C + E) df = stepmix(C, D, E, df);
	else if (df < A) df = 0.0;
	else if (df < B) df = B;
	else if (df < C) df = C;
	else df = D;
	E = fwidth(sf);
	if (sf > 0.5 - E && sf < 0.5 + E)
		sf = smoothstep(0.5 - E, 0.5 + E, sf);
	else
		sf = step(0.5, sf);
	vec3 a = vClr.rgb * ambient;
	vec3 d = max(df, 0.0) * vClr.rgb * diffuse;
	color.rgb = a + d + (specular * sf);
	color.a = opacity;
}`;

//unused: requires gl.Disable(GL_DEPTH_TEST)
// however, depth test must be ENABLED for meshes not using this shader
// since fragments computed in parallel, this leads to artifacts when multiple meshes loaded with different shaders
/*export var fragMeshXRayShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN, vV;
out vec4 color;
void main() {
	float Ambient = 0.5;
	float EdgeFallOff = 1.0;
	float Intensity = 0.5;
	bool DimBackfaces = false;
	float opac = abs(dot(normalize(-vN), normalize(-vV)));
	opac = Ambient + Intensity*(1.0-pow(opac, EdgeFallOff));
	float backface = 1.0 - step(0.0, vN.z);
	opac = mix(opac, 0.0, backface * float(DimBackfaces)); //reverse normal if backface AND two-sided lighting
	color = vec4(opac * vClr.rgb, opac);
}`;*/

//outline
export var fragMeshOutlineShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN;
out vec4 color;
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float ambient = 0.3;
	float diffuse = 0.6;
	float specular = 0.25;
	float shininess = 10.0;
	float PenWidth = 0.6;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float lightNormDot = dot(n, l);
	float view = abs(dot(n,r)); //with respect to viewer
	if (PenWidth < view) discard;
	vec3 a = vClr.rgb * ambient;
	vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
	float s = specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
	color.rgb = a + d + s;
	color.a = opacity;
}`;

//Phong headlight shader for edge enhancement, opposite of fresnel rim lighting
export var fragMeshEdgeShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN;
out vec4 color;
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float diffuse = 1.0;
	float specular = 0.2;
	float shininess = 10.0;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 0.0, -5.0);
	vec3 l = normalize(lightPosition);
	float lightNormDot = max(dot(n, l), 0.0);
	vec3 d = lightNormDot * vClr.rgb * diffuse;
	float s = specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
	color = vec4(d + s, opacity);
}`;

//Phong: default
export var fragMeshShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN;
out vec4 color;
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float ambient = 0.35;
	float diffuse = 0.5;
	float specular = 0.2;
	float shininess = 10.0;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float lightNormDot = dot(n, l);
	vec3 a = vClr.rgb * ambient;
	vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
	float s = specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
	color = vec4(a + d + s, opacity);
}`;

//Matcap: modulate mesh color with spherical matcap image
export var fragMeshMatcapShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN;
uniform sampler2D matCap;
out vec4 color;
void main() {
	vec3 n = normalize(vN);
	vec2 uv = n.xy * 0.5 + 0.5;
	uv.y = 1.0 - uv.y;
	vec3 clr = texture(matCap,uv.xy).rgb * vClr.rgb;
	color = vec4(clr, opacity);
}`;

//matte: same as phong without specular and a bit more diffuse
export var fragMeshMatteShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN;
out vec4 color;
void main() {
	float ambient = 0.35;
	float diffuse = 0.6;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float lightNormDot = dot(n, l);
	vec3 a = vClr.rgb * ambient;
	vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
	color = vec4(a + d, opacity);
}`;

//Hemispheric
export var fragMeshHemiShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN;
out vec4 color;
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float ambient = 0.35;
	float diffuse = 0.5;
	float specular = 0.2;
	float shininess = 10.0;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float lightNormDot = dot(n, l);
	vec3 up = vec3(0.0, 1.0, 0.0);
	float ax = dot(n, up) * 0.5 + 0.5;  //Shreiner et al. (2013) OpenGL Programming Guide, 8th Ed., p 388. ISBN-10: 0321773039
	vec3 upClr = vec3(1.0, 1.0, 0.95);
	vec3 downClr = vec3(0.4, 0.4, 0.6);
	vec3 a = vClr.rgb * ambient;
	a *= mix(downClr, upClr, ax);
	vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
	float s = specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
	color = vec4(a + d + s, opacity);
}`;

export var fragMeshShaderSHBlue = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN;
out vec4 color;
//Spherical harmonics constants
const float C1 = 0.429043;
const float C2 = 0.511664;
const float C3 = 0.743125;
const float C4 = 0.886227;
const float C5 = 0.247708;
//Spherical harmonics coefficients
// Ramamoorthi, R., and P. Hanrahan. 2001b. "An Efficient Representation for Irradiance Environment Maps." In Proceedings of SIGGRAPH 2001, pp. 497–500.
// https://github.com/eskimoblood/processingSketches/blob/master/data/shader/shinyvert.glsl
// https://github.com/eskimoblood/processingSketches/blob/master/data/shader/shinyvert.glsl
// Constants for Eucalyptus Grove lighting
const vec3 L00  = vec3( 0.3783264,  0.4260425,  0.4504587);
const vec3 L1m1 = vec3( 0.2887813,  0.3586803,  0.4147053);
const vec3 L10  = vec3( 0.0379030,  0.0295216,  0.0098567);
const vec3 L11  = vec3(-0.1033028, -0.1031690, -0.0884924);
const vec3 L2m2 = vec3(-0.0621750, -0.0554432, -0.0396779);
const vec3 L2m1 = vec3( 0.0077820, -0.0148312, -0.0471301);
const vec3 L20  = vec3(-0.0935561, -0.1254260, -0.1525629);
const vec3 L21  = vec3(-0.0572703, -0.0502192, -0.0363410);
const vec3 L22  = vec3( 0.0203348, -0.0044201, -0.0452180);
vec3 SH(vec3 vNormal) {
	vNormal = vec3(vNormal.x,vNormal.z,vNormal.y);
	vec3 diffuseColor = C1 * L22 * (vNormal.x * vNormal.x - vNormal.y * vNormal.y) +
	C3 * L20 * vNormal.z * vNormal.z +
	C4 * L00 -
	C5 * L20 +
	2.0 * C1 * L2m2 * vNormal.x * vNormal.y +
	2.0 * C1 * L21  * vNormal.x * vNormal.z +
	2.0 * C1 * L2m1 * vNormal.y * vNormal.z +
	2.0 * C2 * L11  * vNormal.x +
	2.0 * C2 * L1m1 * vNormal.y +
	2.0 * C2 * L10  * vNormal.z;
	return diffuseColor;
}
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float ambient = 0.3;
	float diffuse = 0.6;
	float specular = 0.1;
	float shininess = 10.0;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float s = specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
	vec3 a = vClr.rgb * ambient;
	vec3 d = vClr.rgb * diffuse * SH(-reflect(n, vec3(l.x, l.y, -l.z)) );
	color = vec4(a + d + s, opacity);
}`;

export var vertFlatMeshShader = `#version 300 es
layout(location=0) in vec3 pos;
layout(location=1) in vec4 norm;
layout(location=2) in vec4 clr;
uniform mat4 mvpMtx;
//uniform mat4 modelMtx;
uniform mat4 normMtx;
out vec4 vClr;
flat out vec3 vN;
void main(void) {
	gl_Position = mvpMtx * vec4(pos, 1.0);
	vN = normalize((normMtx * vec4(norm.xyz,1.0)).xyz);
	//vV = -vec3(modelMtx*vec4(pos,1.0));
	vClr = clr;
}`;

export var fragFlatMeshShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
flat in vec3 vN;
out vec4 color;
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float ambient = 0.35;
	float diffuse = 0.5;
	float specular = 0.2;
	float shininess = 10.0;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float lightNormDot = dot(n, l);
	vec3 a = vClr.rgb * ambient;
	vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
	float s = specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
	color = vec4(a + d + s, opacity);
}`;

export var fragVolumePickingShader =
  `#version 300 es
#line 506
//precision highp int;
precision highp float;
uniform vec3 rayDir;
uniform vec3 volScale;
uniform vec3 texVox;
uniform vec4 clipPlane;
uniform highp sampler3D volume, overlay;
uniform float overlays;
uniform mat4 matRAS;
uniform mat4 mvpMtx;
uniform float drawOpacity;
uniform highp sampler3D drawing;
uniform highp sampler2D colormap;
uniform int backgroundMasksOverlays;
in vec3 vColor;
out vec4 fColor;
` +
  kRenderFunc +
  `
void main() {
	int id = 254;
	vec3 start = vColor;
	gl_FragDepth = 0.0;
	fColor = vec4(0.0, 0.0, 0.0, 0.0); //assume no hit: ID = 0
	float fid = float(id & 255)/ 255.0;
	vec3 backPosition = GetBackPosition(start);
	vec3 dir = backPosition - start;
	float len = length(dir);
	float lenVox = length((texVox * start) - (texVox * backPosition));
	if ((lenVox < 0.5) || (len > 3.0)) return;//discard; //length limit for parallel rays
	float sliceSize = len / lenVox; //e.g. if ray length is 1.0 and traverses 50 voxels, each voxel is 0.02 in unit cube
	float stepSize = sliceSize; //quality: larger step is faster traversal, but fewer samples
	float opacityCorrection = stepSize/sliceSize;
	dir = normalize(dir);
	vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	float lenNoClip = len;
	bool isClip = false;
	vec4 clipPos = applyClip(dir, samplePos, len, isClip);
	if (isClip) fColor = vec4(samplePos.xyz, 253.0 / 255.0); //assume no hit: ID = 0
	//start: OPTIONAL fast pass: rapid traversal until first hit
	float stepSizeFast = sliceSize * 1.9;
	vec4 deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(volume, samplePos.xyz).a;
		if (val > 0.01) {
			fColor = vec4(samplePos.rgb, fid);
			gl_FragDepth = frac2ndc(samplePos.xyz);
			break;
		}
		samplePos += deltaDirFast; //advance ray position
	}
	//end: fast pass
	if ((overlays < 1.0) || (backgroundMasksOverlays > 0)) {
		return; //background hit, no overlays
	}
	//overlay pass
	len = min(lenNoClip, samplePos.a); //only find overlay closer than background
	samplePos = vec4(start.xyz, 0.0); //ray position
	while (samplePos.a <= len) {
		float val = texture(overlay, samplePos.xyz).a;
		if (val > 0.01) {
			fColor = vec4(samplePos.rgb, fid);
			gl_FragDepth = frac2ndc(samplePos.xyz);
			return;
		}
		samplePos += deltaDirFast; //advance ray position
	}
	//if (fColor.a == 0.0) discard; //no hit in either background or overlays
	//you only get here if there is a hit with the background that is closer than any overlay
}`;

export var vertOrientCubeShader = `#version 300 es
// an attribute is an input (in) to a vertex shader.
// It will receive data from a buffer
layout(location=0)  in vec3 a_position;
layout(location=1)  in vec3 a_color;
// A matrix to transform the positions by
uniform mat4 u_matrix;
out vec3 vColor;
// all shaders have a main function
void main() {
	// Multiply the position by the matrix.
	vec4 pos = vec4(a_position, 1.0);
	gl_Position = u_matrix * vec4(pos);
	vColor = a_color;
}
`;

export var fragOrientCubeShader = `#version 300 es
precision highp float;
uniform vec4 u_color;
in vec3 vColor;
out vec4 outColor;
void main() {
	outColor = vec4(vColor, 1.0);
}`;
