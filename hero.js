// Rijoda Labs, hero sculpture.
// Loads the Säntis GLB (meshopt compressed) and slowly rotates it as a full-bleed
// backdrop behind the hero copy. The model is cover-fitted so its edges never show.
// Self-contained: three.js, GLTFLoader, MeshoptDecoder and RoomEnvironment are vendored locally.
// Uses a lighter model on small or low-power devices. Falls back to the static CSS hero
// only when WebGL is unavailable or data-saver is on; reduced motion renders a still frame.

// three.js and its loaders are imported dynamically inside boot(), after the
// capability guards below, so a skipped or reduced-motion device never pays for
// the ~690 KB vendor bundle. The importmap in index.html resolves 'three'.
const THREE_URL = 'three';
const LOADER_URLS = [
  './vendor/jsm/loaders/GLTFLoader.js',
  './vendor/jsm/libs/meshopt_decoder.module.js',
  './vendor/jsm/environments/RoomEnvironment.js'
];

const MODEL_FULL = './models/saentis.glb';       // desktop
const MODEL_LITE = './models/saentis-lite.glb';  // mobile / low-power
const ROTATION = 0.04;      // radians per second, deliberately slow
const WIDTH_OVERSCAN = 1.05; // sides just off-frame, summit fully visible
const PEAK_NDC_Y = 0.34;     // summit sits just above the hero copy (0 = centre, 1 = top)
const REF_ASPECT = 1.4;      // framing is computed for this aspect, so zoom and position stay
                             // identical on every device (portrait simply crops the sides more)

async function boot() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = !!(navigator.connection && navigator.connection.saveData);

  let gl = null;
  try {
    const probe = document.createElement('canvas');
    gl = probe.getContext('webgl2') || probe.getContext('webgl');
  } catch (e) { /* no WebGL */ }

  if (!gl || saveData) {
    canvas.dataset.state = 'skipped';
    return;
  }

  // lighter model and lower pixel ratio on small or low-power devices.
  // `?model=lite|full` forces a variant (handy for previewing the mobile build).
  const forced = new URLSearchParams(window.location.search).get('model');
  const light = forced
    ? forced === 'lite'
    : (window.matchMedia('(max-width: 860px)').matches ||
       (navigator.hardwareConcurrency || 8) <= 4 ||
       (navigator.deviceMemory || 8) <= 4);

  canvas.dataset.state = 'loading';

  let THREE, GLTFLoader, MeshoptDecoder, RoomEnvironment;
  try {
    const [three, gltf, meshopt, room] = await Promise.all([
      import(THREE_URL),
      import(LOADER_URLS[0]),
      import(LOADER_URLS[1]),
      import(LOADER_URLS[2])
    ]);
    THREE = three;
    GLTFLoader = gltf.GLTFLoader;
    MeshoptDecoder = meshopt.MeshoptDecoder;
    RoomEnvironment = room.RoomEnvironment;
  } catch (e) {
    // vendor bundle missing or blocked: degrade to the static CSS hero
    canvas.dataset.state = 'error';
    return;
  }

  start(canvas, {
    reduce,
    light,
    url: light ? MODEL_LITE : MODEL_FULL,
    THREE,
    GLTFLoader,
    MeshoptDecoder,
    RoomEnvironment
  });
}

function start(canvas, { reduce, light, url, THREE, GLTFLoader, MeshoptDecoder, RoomEnvironment }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'low-power'
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, light ? 1.5 : 2));

  const scene = new THREE.Scene();
  // soft studio environment so the PBR textures read properly
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 7);
  camera.lookAt(0, 0, 0);

  // soft, warm studio lighting
  scene.add(new THREE.HemisphereLight(0xffffff, 0xe8e2d8, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(-4, 6, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xfff0e6, 0.22);
  fill.position.set(5, -2, -4);
  scene.add(fill);

  const group = new THREE.Group();
  scene.add(group);

  let modelSize = null;
  let modelTopY = 0;

  // cover-fit: scale the model so it always fills the viewport on every side
  function fit() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!modelSize) return;

    const dist = camera.position.z;
    const viewH = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * dist;
    const viewW = viewH * REF_ASPECT; // fixed reference width, not the device aspect
    const footW = Math.max(modelSize.x, modelSize.z); // spins around Y, so use the widest footprint
    const scale = (viewW / footW) * WIDTH_OVERSCAN;
    group.scale.setScalar(scale);
    // place the summit at a fixed height; the base bleeds off the bottom
    group.position.y = (PEAK_NDC_Y * viewH / 2) - (modelTopY * scale);
  }

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load(
    url,
    (gltf) => {
      const model = gltf.scene;
      model.traverse((o) => {
        if (o.isMesh) {
          o.frustumCulled = false;
          const m = o.material;
          if (m && m.isMeshStandardMaterial) {
            m.metalness = 0.0;      // Tripo metalness often reads like foil
            m.roughness = 0.9;
            m.envMapIntensity = 0.5;
            m.needsUpdate = true;
          }
        }
      });

      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());

      // align the summit with the rotation axis so it stays centred while spinning
      let topY = -Infinity, px = 0, pz = 0;
      const v = new THREE.Vector3();
      model.traverse((o) => {
        if (o.isMesh && o.geometry && o.geometry.attributes.position) {
          const pos = o.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            if (v.y > topY) { topY = v.y; px = v.x; pz = v.z; }
          }
        }
      });
      model.position.x -= px;
      model.position.z -= pz;

      modelSize = size;
      modelTopY = topY;
      group.add(model);

      fit();
      canvas.dataset.state = 'ready';
    },
    undefined,
    () => { canvas.dataset.state = 'error'; }
  );

  fit();
  window.addEventListener('resize', fit, { passive: true });
  window.addEventListener('orientationchange', fit, { passive: true });

  let visible = true;
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!reduce) group.rotation.y += dt * ROTATION;
    renderer.render(scene, camera);
  });
}

// defer until the page has settled so the hero text paints first
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
if (document.readyState === 'complete') idle(boot);
else window.addEventListener('load', () => idle(boot), { once: true });
