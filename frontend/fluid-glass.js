/* FluidGlass navbar: the React Bits <FluidGlass mode="bar"> component
   (reactbits.dev, MIT + Commons Clause, (c) David Haz), ported to run without a
   build step and laid behind the HTML nav instead of over a demo scene.

   WebGL glass can only bend what is inside its own scene, not the DOM, so the
   scene's backdrop is the page background repainted every frame for the strip
   under the nav (same --bg and sky glows as body, offset by scroll), plus a few
   slow palette blobs so the bending is visible. The HTML links stay on top and
   keep working; if WebGL or the CDN is unavailable the CSS nav is left as is. */

import * as THREE from 'three';
import { createElement, useRef, useState, useEffect, useMemo, memo, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, createPortal, useFrame, useThree } from '@react-three/fiber';
import { useFBO, useGLTF, MeshTransmissionMaterial } from '@react-three/drei';
import { easing } from 'maath';
import htm from 'htm';

const html = htm.bind(createElement);
const BAR_GLB = new URL('assets/3d/bar.glb', document.baseURI).href;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function FluidGlass({ mode = 'bar', barProps = {}, navEl, onReady }) {
  return html`
    <${Canvas}
      camera=${{ position: [0, 0, 20], fov: 15 }}
      gl=${{ alpha: true, antialias: true, toneMapping: THREE.NoToneMapping }}
      dpr=${[1, 2]}
    >
      <${Suspense} fallback=${null}>
        ${mode === 'bar' && html`<${Bar} modeProps=${barProps} navEl=${navEl} onReady=${onReady} />`}
      <//>
    <//>`;
}

const ModeWrapper = memo(function ModeWrapper({ glb, geometryKey, modeProps = {}, navEl, onReady, ...props }) {
  const ref = useRef();
  const { nodes } = useGLTF(glb);
  const buffer = useFBO();
  const { viewport: vp, camera } = useThree();
  const [scene] = useState(() => new THREE.Scene());
  const backdrop = useMemo(() => makeBackdrop(navEl), [navEl]);
  const geoSize = useRef(new THREE.Vector3(1, 1, 1));
  const back = viewport => viewport.getCurrentViewport(camera, [0, 0, -5]);

  useEffect(() => {
    const geo = nodes[geometryKey]?.geometry;
    geo.computeBoundingBox();
    geo.boundingBox.getSize(geoSize.current);
    onReady?.();
    return () => backdrop.dispose();
  }, [nodes, geometryKey, onReady, backdrop]);

  useFrame((state, delta) => {
    const { gl, viewport, camera } = state;
    const v = viewport.getCurrentViewport(camera, [0, 0, 15]);

    // The bar is the nav: stretch it to the canvas. The model lies flat, so
    // after rotation-x its z extent is the on-screen height.
    const g = geoSize.current;
    const sy = (v.height * 0.94) / g.z;
    easing.damp3(ref.current.scale, [(v.width * 0.995) / g.x, sy, sy], 0.12, delta);

    backdrop.paint(state.clock.elapsedTime, delta);

    gl.setClearColor(0x000000, 0);
    gl.setRenderTarget(buffer);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    gl.setClearColor(0x000000, 0);
  });

  const { scale, ior, thickness, anisotropy, chromaticAberration, ...extraMat } = modeProps;
  const bv = back(vp);

  return html`
    ${createPortal(
      html`<mesh position=${[0, 0, -5]} scale=${[bv.width, bv.height, 1]}>
        <planeGeometry />
        <meshBasicMaterial map=${backdrop.texture} toneMapped=${false} />
      </mesh>`,
      scene
    )}
    <mesh scale=${[vp.width, vp.height, 1]}>
      <planeGeometry />
      <meshBasicMaterial map=${buffer.texture} transparent toneMapped=${false} />
    </mesh>
    <mesh ref=${ref} position=${[0, 0, 15]} rotation-x=${Math.PI / 2} geometry=${nodes[geometryKey]?.geometry} ...${props}>
      <${MeshTransmissionMaterial}
        buffer=${buffer.texture}
        ior=${ior ?? 1.15}
        thickness=${thickness ?? 5}
        anisotropy=${anisotropy ?? 0.01}
        chromaticAberration=${chromaticAberration ?? 0.1}
        ...${extraMat}
      />
    </mesh>`;
});

function Bar({ modeProps = {}, ...p }) {
  const defaultMat = {
    transmission: 1,
    roughness: 0,
    thickness: 10,
    ior: 1.15,
    color: '#ffffff',
    attenuationColor: '#ffffff',
    attenuationDistance: 0.25
  };
  return html`<${ModeWrapper} glb=${BAR_GLB} geometryKey="Cube" modeProps=${{ ...defaultMat, ...modeProps }} ...${p} />`;
}

/* The page background for the strip under the nav, as a texture. Mirrors the
   body background in styles.css: --bg plus two sky radial glows positioned on
   the root box, so it lines up with what is really behind the nav at any scroll. */
function makeBackdrop(navEl) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  let colors = readColors();
  const refresh = () => { colors = readColors(); };
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', refresh);
  const themeWatch = new MutationObserver(refresh);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  let drift = 0;
  let lastScroll = scrollY;
  const stir = { wake: 0 };

  function paint(time, delta) {
    const r = navEl.getBoundingClientRect();
    const doc = document.documentElement.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      texture.dispose();
    }

    // Scrolling stirs the blobs; they settle back when it stops.
    const dy = scrollY - lastScroll;
    lastScroll = scrollY;
    easing.damp(stir, 'wake', Math.min(Math.abs(dy) / 40, 1), 0.25, delta);
    if (!reduceMotion.matches) drift += delta * (0.05 + stir.wake * 0.6) + dy * 0.0006;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, r.width, r.height);

    // body glows, in document coordinates
    ctx.save();
    ctx.translate(doc.left - r.left, doc.top - r.top);
    glow(ctx, doc.width * 0.08, doc.height * -0.08, 1100, 620, colors.sky, 0.38, 0.62);
    glow(ctx, doc.width, doc.height * 0.18, 900, 520, colors.sky, 0.18, 0.6);
    ctx.restore();

    // palette blobs, in nav coordinates
    const blobs = [
      [colors.sky, 0.0, 0.55, 0.07],
      [colors.primaryHi, 0.27, 0.32, 0.05],
      [colors.skySoft, 0.53, 0.6, 0.09],
      [colors.blueSoft, 0.79, 0.4, 0.06]
    ];
    for (const [c, phase, a, speed] of blobs) {
      const t = drift * speed * 10 + phase;
      const x = (((t % 1) + 1) % 1) * (r.width + r.height * 3) - r.height * 1.5;
      const y = r.height * (0.5 + 0.45 * Math.sin((t + time * 0.02) * Math.PI * 2));
      glow(ctx, x, y, r.height * 2.2, r.height * 1.3, c, a, 1);
    }

    texture.needsUpdate = true;
  }

  return {
    texture,
    paint,
    dispose() {
      scheme.removeEventListener('change', refresh);
      themeWatch.disconnect();
      texture.dispose();
    }
  };
}

function glow(ctx, cx, cy, rx, ry, rgb, alpha, end) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(end, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const rgb = name => {
    const hex = css.getPropertyValue(name).trim().replace('#', '');
    const n = parseInt(hex.length === 3 ? hex.replace(/./g, '$&$&') : hex, 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  };
  return {
    bg: css.getPropertyValue('--bg').trim(),
    sky: rgb('--sky'),
    primaryHi: rgb('--primary-hi'),
    skySoft: rgb('--sky-soft'),
    blueSoft: rgb('--blue-soft')
  };
}

function hasWebGL() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

const host = document.querySelector('.nav-glass');
if (host && hasWebGL()) {
  const nav = host.closest('.nav');
  const onReady = () => nav.classList.add('glass-on');
  createRoot(host).render(html`<${FluidGlass} mode="bar" navEl=${nav} onReady=${onReady} />`);
}
