import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const PROFILES = {
  original: { width: 0, height: 0, samples: 0 },
  dreamcast: { width: 640, height: 480, samples: 4 },
  ps1: { width: 320, height: 240, samples: 0 },
  ps2: { width: 640, height: 480, samples: 0 },
};

/**
 * Fixed-resolution console-inspired rendering, independent of the scene/model.
 * The scene target remains linear HDR. Tone mapping and display conversion are
 * applied exactly once, by the final screen shader.
 */
export function createRetroRenderer({ renderer, scene, camera }) {
  let style = 'original';
  let mood = 'character-select';
  let cssWidth = 1;
  let cssHeight = 1;
  let frameRect = { x: 0, y: 0, width: 1, height: 1 };
  let disposed = false;
  const targets = new Map();
  const material = new THREE.ShaderMaterial({
    name: 'Noir console presentation',
    depthTest: false,
    depthWrite: false,
    toneMapped: true,
    uniforms: {
      tScene: { value: null },
      uSceneSize: { value: new THREE.Vector2(640, 480) },
      uFrame: { value: new THREE.Vector4(0, 0, 1, 1) },
      uPS1: { value: 0 },
      uPS2: { value: 0 },
      uFoggyTown: { value: 0 },
      uSkyTop: { value: new THREE.Color('#238fef') },
      uSkyMiddle: { value: new THREE.Color('#78e3f4') },
      uGround: { value: new THREE.Color('#fff0cf') },
      uOutside: { value: new THREE.Color('#e0f2f6') },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tScene;
      uniform vec2 uSceneSize;
      uniform vec4 uFrame;
      uniform float uPS1;
      uniform float uPS2;
      uniform float uFoggyTown;
      uniform vec3 uSkyTop;
      uniform vec3 uSkyMiddle;
      uniform vec3 uGround;
      uniform vec3 uOutside;
      varying vec2 vUv;

      float bayer2(vec2 p) {
        return 2.0 * mod(p.x + p.y, 2.0) + p.y;
      }
      float bayer4(vec2 p) {
        p = mod(floor(p), 4.0);
        return (4.0 * bayer2(mod(p, 2.0)) + bayer2(floor(p / 2.0)) + 0.5) / 16.0 - 0.5;
      }
      vec3 sunnyBackground(vec2 uv) {
        vec3 sky = mix(uSkyMiddle, uSkyTop, smoothstep(0.25, 1.0, uv.y));
        // A luminous seamless studio floor keeps the original composition.
        sky = mix(uGround, sky, smoothstep(0.10, 0.34, uv.y));
        vec2 sunDelta = (uv - vec2(0.875, 0.845)) * vec2(1.333333, 1.0);
        float sunDistance = length(sunDelta);
        float sunDisc = 1.0 - smoothstep(0.025, 0.038, sunDistance);
        float sunHalo = exp(-sunDistance * sunDistance * 80.0);
        sky += vec3(1.0, 0.77, 0.40) * (sunDisc * 1.2 + sunHalo * 0.16);
        return sky;
      }
      float menuLine(vec2 p, vec2 a, vec2 b) {
        vec2 direction = b - a;
        float t = clamp(dot(p - a, direction) / dot(direction, direction), 0.0, 1.0);
        return 1.0 - smoothstep(0.0012, 0.0028, length(p - a - direction * t));
      }
      float menuBox(vec2 p, vec2 halfSize) {
        vec2 edge = abs(p) - halfSize;
        float distance = max(edge.x, edge.y);
        return 1.0 - smoothstep(0.0013, 0.0027, abs(distance));
      }
      float menuCube(vec2 uv, vec2 center, float size) {
        vec2 p = (uv - center) * vec2(1.333333, 1.0);
        vec2 size2 = vec2(size, size * 0.85);
        vec2 shift = vec2(size * 0.46, size * 0.36);
        float cube = menuBox(p, size2) + menuBox(p - shift, size2);
        cube += menuLine(p, -size2, -size2 + shift);
        cube += menuLine(p, size2, size2 + shift);
        cube += menuLine(p, size2 * vec2(-1.0, 1.0), size2 * vec2(-1.0, 1.0) + shift);
        cube += menuLine(p, size2 * vec2(1.0, -1.0), size2 * vec2(1.0, -1.0) + shift);
        return clamp(cube, 0.0, 1.0);
      }
      float townHash(float n) {
        return fract(sin(n * 12.9898 + 38.743) * 43758.5453);
      }
      vec3 ps2Background(vec2 uv) {
        vec3 sky = mix(uSkyMiddle, uSkyTop, smoothstep(0.23, 1.0, uv.y));
        if (uFoggyTown < 0.5) {
          // A quiet memory-card menu: royal blue, translucent geometry, and
          // a luminous floor. These details remain behind the character.
          vec2 glowDelta = (uv - vec2(0.5, 0.43)) * vec2(1.0, 1.15);
          sky += vec3(0.035, 0.09, 0.22) * exp(-dot(glowDelta, glowDelta) * 8.0);
          vec2 orbit = uv - vec2(0.5, 0.46);
          orbit = vec2(orbit.x + orbit.y * 0.3, orbit.y - orbit.x * 0.12);
          float ringA = exp(-abs(length(orbit / vec2(0.46, 0.24)) - 1.0) * 170.0);
          float ringB = exp(-abs(length(orbit / vec2(0.57, 0.35)) - 1.0) * 210.0);
          float cubes = menuCube(uv, vec2(0.15, 0.63), 0.043);
          cubes += menuCube(uv, vec2(0.81, 0.54), 0.054);
          cubes += menuCube(uv, vec2(0.72, 0.84), 0.029);
          sky += vec3(0.07, 0.15, 0.27) * (ringA * 0.23 + ringB * 0.17 + cubes * 0.20);
          float floorMask = 1.0 - smoothstep(0.18, 0.32, uv.y);
          float floorDepth = max(0.035, 0.32 - uv.y);
          float gridX = abs(fract((uv.x - 0.5) / (floorDepth + 0.12) * 2.0) - 0.5);
          float gridY = abs(fract(0.035 / floorDepth * 4.0) - 0.5);
          float grid = (1.0 - smoothstep(0.007, 0.018, min(gridX, gridY))) * floorMask;
          sky = mix(uGround, sky, smoothstep(0.02, 0.30, uv.y));
          sky += vec3(0.035, 0.07, 0.11) * grid * 0.4;
        } else {
          // Three shallow silhouettes suggest a town beyond the fog rather
          // than imposing a new 3D camera or scene on the original pose.
          float farCell = floor(uv.x * 19.0);
          float farRoof = 0.42 + townHash(farCell + 3.0) * 0.16;
          float farBuildings = step(uv.y, farRoof) * step(0.25, uv.y);
          sky = mix(sky, vec3(0.25, 0.31, 0.29), farBuildings * 0.12);
          float midCell = floor(uv.x * 12.0);
          float midRoof = 0.31 + townHash(midCell + 19.0) * 0.22;
          float midBuildings = step(uv.y, midRoof) * step(0.23, uv.y);
          sky = mix(sky, vec3(0.19, 0.25, 0.23), midBuildings * 0.19);
          float nearCell = floor(uv.x * 8.0);
          float nearRoof = 0.26 + townHash(nearCell + 41.0) * 0.18;
          float nearBuildings = step(uv.y, nearRoof) * step(0.20, uv.y);
          sky = mix(sky, vec3(0.16, 0.22, 0.20), nearBuildings * 0.15);
          float windowX = 1.0 - smoothstep(0.11, 0.22, abs(fract(uv.x * 24.0) - 0.5));
          float windowY = 1.0 - smoothstep(0.13, 0.23, abs(fract(uv.y * 31.0) - 0.5));
          float windows = windowX * windowY * midBuildings * step(uv.y, midRoof - 0.025);
          sky += vec3(0.025, 0.023, 0.012) * windows;
          float distanceVeil = smoothstep(0.24, 0.78, uv.y) * 0.24;
          sky = mix(sky, vec3(0.39, 0.47, 0.43), distanceVeil);
          sky = mix(uGround, sky, smoothstep(0.06, 0.27, uv.y));
          float groundFog = exp(-pow((uv.y - 0.24) / 0.095, 2.0));
          sky = mix(sky, vec3(0.43, 0.50, 0.46), groundFog * 0.16);
        }
        return sky;
      }
      void main() {
        vec2 sceneUv = (vUv - uFrame.xy) / uFrame.zw;
        bool inside = sceneUv.x >= 0.0 && sceneUv.x <= 1.0 && sceneUv.y >= 0.0 && sceneUv.y <= 1.0;
        vec3 color = uOutside;
        if (inside) {
          vec2 uv = sceneUv;
          vec2 texel = 1.0 / uSceneSize;
          if (uPS1 > 0.5 || uPS2 > 0.5) uv = (floor(uv * uSceneSize) + 0.5) / uSceneSize;
          vec4 image = texture2D(tScene, uv);
          if (uPS2 > 0.5) {
            // A non-antialiased 480-line signal with slight composite softness
            // and less than one pixel of restrained chroma bleed.
            image = image * 0.82
              + texture2D(tScene, uv + vec2(texel.x * 0.5, 0.0)) * 0.09
              + texture2D(tScene, uv - vec2(texel.x * 0.5, 0.0)) * 0.09;
            image.r = mix(image.r, texture2D(tScene, uv + vec2(texel.x * 0.65, 0.0)).r, 0.12);
            image.b = mix(image.b, texture2D(tScene, uv - vec2(texel.x * 0.65, 0.0)).b, 0.12);
            if (uFoggyTown > 0.5) image.rgb = mix(image.rgb, vec3(0.30, 0.37, 0.34) * image.a, 0.13);
          } else if (uPS1 < 0.5) {
            // Slight horizontal VGA softness, without visible scanlines.
            image = image * 0.74
              + texture2D(tScene, uv + vec2(texel.x * 0.65, 0.0)) * 0.13
              + texture2D(tScene, uv - vec2(texel.x * 0.65, 0.0)) * 0.13;
          }
          vec3 background = uPS2 > 0.5 ? ps2Background(uv) : sunnyBackground(uv);
          // Multisample edge pixels are premultiplied by coverage in the target.
          color = image.rgb + background * (1.0 - image.a);
          if (uPS2 > 0.5) {
            vec3 bloom = vec3(0.0);
            bloom += max(texture2D(tScene, uv + texel * vec2(1.5, 0.0)).rgb - 1.4, 0.0);
            bloom += max(texture2D(tScene, uv - texel * vec2(1.5, 0.0)).rgb - 1.4, 0.0);
            bloom += max(texture2D(tScene, uv + texel * vec2(0.0, 1.5)).rgb - 1.4, 0.0);
            bloom += max(texture2D(tScene, uv - texel * vec2(0.0, 1.5)).rgb - 1.4, 0.0);
            color += bloom * 0.008;
          } else if (uPS1 < 0.5) {
            vec3 bloom = vec3(0.0);
            bloom += max(texture2D(tScene, uv + texel * vec2(2.0, 0.0)).rgb - 1.0, 0.0);
            bloom += max(texture2D(tScene, uv - texel * vec2(2.0, 0.0)).rgb - 1.0, 0.0);
            bloom += max(texture2D(tScene, uv + texel * vec2(0.0, 2.0)).rgb - 1.0, 0.0);
            bloom += max(texture2D(tScene, uv - texel * vec2(0.0, 2.0)).rgb - 1.0, 0.0);
            color += bloom * 0.027;
            float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
            color = mix(vec3(luminance), color, 1.13);
            // Restrained lens ghosts along the sun-to-center axis.
            vec2 flare = (uv - vec2(0.69, 0.67)) * vec2(1.333333, 1.0);
            color += vec3(0.26, 0.52, 0.62) * exp(-dot(flare, flare) * 800.0) * 0.025;
            vec2 ghost = (uv - vec2(0.36, 0.34)) * vec2(1.333333, 1.0);
            color += vec3(0.6, 0.38, 0.15) * exp(-dot(ghost, ghost) * 280.0) * 0.009;
          }
        }
        gl_FragColor = vec4(max(color, 0.0), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // The display surround is UI paper, rather than HDR scene lighting.
        if (!inside) {
          if (uPS2 > 0.5) gl_FragColor = uFoggyTown > 0.5 ? vec4(0.76, 0.81, 0.79, 1.0) : vec4(0.79, 0.86, 0.97, 1.0);
          else gl_FragColor = vec4(0.885, 0.966, 1.0, 1.0);
        }
        if (uPS1 > 0.5 && inside) {
          // Dither the final display colors into a 15-bit RGB palette.
          float dither = bayer4(sceneUv * uSceneSize) / 31.0;
          gl_FragColor.rgb = clamp(floor(gl_FragColor.rgb * 31.0 + dither * 31.0 + 0.5) / 31.0, 0.0, 1.0);
        } else if (uPS2 > 0.5 && inside) {
          // A quiet alternating field pattern, followed by faint RGB7 banding.
          // The PS1's coarse RGB5 palette and ordered dither remain distinct.
          float scanline = mod(floor(sceneUv.y * 480.0), 2.0);
          gl_FragColor.rgb *= 1.0 - scanline * 0.025;
          float dither = bayer4(sceneUv * uSceneSize) * 0.35;
          gl_FragColor.rgb = clamp(floor(gl_FragColor.rgb * 127.0 + dither + 0.5) / 127.0, 0.0, 1.0);
        }
      }
    `,
  });
  const quad = new FullScreenQuad(material);

  function targetFor(profileName) {
    if (targets.has(profileName)) return targets.get(profileName);
    const profile = PROFILES[profileName];
    const nearest = profileName === 'ps1' || profileName === 'ps2';
    const target = new THREE.WebGLRenderTarget(profile.width, profile.height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: nearest ? THREE.NearestFilter : THREE.LinearFilter,
      magFilter: nearest ? THREE.NearestFilter : THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: Math.min(profile.samples, renderer.capabilities.maxSamples),
      generateMipmaps: false,
    });
    target.texture.name = `Noir ${profileName} ${profile.width}x${profile.height}`;
    target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    targets.set(profileName, target);
    return target;
  }

  function setSize(width, height) {
    cssWidth = Math.max(1, width);
    cssHeight = Math.max(1, height);
    if (style === 'original') {
      frameRect = { x: 0, y: 0, width: cssWidth, height: cssHeight };
    } else {
      const width = Math.min(cssWidth, cssHeight * 4 / 3);
      const height = width * 3 / 4;
      frameRect = { x: (cssWidth - width) / 2, y: (cssHeight - height) / 2, width, height };
    }
    // UV origin is at the lower left; the CSS rect starts at the upper left.
    material.uniforms.uFrame.value.set(frameRect.x / cssWidth, 1 - (frameRect.y + frameRect.height) / cssHeight, frameRect.width / cssWidth, frameRect.height / cssHeight);
  }

  function setStyle(nextStyle) {
    if (!(nextStyle in PROFILES)) throw new Error(`Unknown Noir render style: ${nextStyle}`);
    style = nextStyle;
    material.uniforms.uPS1.value = style === 'ps1' ? 1 : 0;
    material.uniforms.uPS2.value = style === 'ps2' ? 1 : 0;
    if (style !== 'original') {
      const profile = PROFILES[style];
      material.uniforms.tScene.value = targetFor(style).texture;
      material.uniforms.uSceneSize.value.set(profile.width, profile.height);
      const colors = style === 'dreamcast'
        ? ['#238fef', '#78e3f4', '#fff0cf', '#e0f2f6']
        : style === 'ps2'
          ? mood === 'foggy-town'
            ? ['#536969', '#9eaaa6', '#bec8c0', '#c2cfc9']
            : ['#091c61', '#234a9d', '#99bded', '#c9dbf7']
          : ['#5975dc', '#9bd7f0', '#ffe5be', '#dfe7f7'];
      ['uSkyTop', 'uSkyMiddle', 'uGround', 'uOutside'].forEach((name, i) => material.uniforms[name].value.set(colors[i]));
    }
    setSize(cssWidth, cssHeight);
  }

  function setMood(nextMood) {
    if (!['character-select', 'foggy-town'].includes(nextMood)) throw new Error(`Unknown Noir PS2 mood: ${nextMood}`);
    mood = nextMood;
    material.uniforms.uFoggyTown.value = mood === 'foggy-town' ? 1 : 0;
    // The mood is remembered while other editions are active, but it changes
    // only the PS2 palette and atmosphere.
    if (style === 'ps2') setStyle(style);
  }

  function render() {
    if (disposed) return;
    if (style === 'original') {
      renderer.render(scene, camera);
      return;
    }
    const previousTarget = renderer.getRenderTarget();
    const previousClearColor = renderer.getClearColor(new THREE.Color());
    const previousClearAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    try {
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(targetFor(style));
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(previousTarget);
      quad.render(renderer);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousClearColor, previousClearAlpha);
      renderer.autoClear = previousAutoClear;
    }
  }

  function getState() {
    const profile = PROFILES[style];
    return {
      style,
      mood,
      width: style === 'original' ? Math.round(cssWidth * renderer.getPixelRatio()) : profile.width,
      height: style === 'original' ? Math.round(cssHeight * renderer.getPixelRatio()) : profile.height,
      fixedResolution: style !== 'original',
      frameRect: { ...frameRect },
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    targets.forEach(target => target.dispose());
    targets.clear();
    material.dispose();
    quad.dispose();
  }

  return { setStyle, setMood, setSize, render, getState, getFrameRect: () => ({ ...frameRect }), dispose };
}
