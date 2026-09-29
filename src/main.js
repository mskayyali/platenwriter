import * as THREE from 'three';
import '@fontsource/courier-prime/400.css';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TAU, deg, clamp, smooth, easeInOut, easeOut, linear, rng, randSeed, mixSeed, mkCanvas } from './util.js';
import { Sound } from './sound.js';
import { romGlyph } from './lcdfont.js';
import * as store from './store.js';

// ============================================================================
//  Units are inches. The platen axis is the world X axis; +Z faces the typist.
// ============================================================================
// ---------------------------------------------------------------- geometry
const R = 0.78, RP = R + 0.012;           // platen radius, paper radius
const DPI = 150, ROLL_LEN = 20, CH = Math.round(ROLL_LEN * DPI);
const PITCH = 0.1, LINE_H = 1 / 6;
// three roll widths, set with the width dial; the widest is Letter with 1" margins
const WIDTHS = [{ w: 8.5, m: 1.0, label: '8½' }, { w: 6, m: .7, label: '6' }, { w: 4, m: .5, label: '4' }];
const SPACINGS = [1, 1.5, 2];
// paper spec carried by every sheet and scrap: width, margin, type ('roll' | 'fan'), roll offset
const paperSpec = (wi, type, v0 = 0) => ({ w: WIDTHS[wi].w, m: WIDTHS[wi].m, type, v0 });
const DEFAULT_SPEC = { w: 8.5, m: 1, type: 'roll', v0: 0 };
// ruled 5×3 index cards: fed one at a time, ejected whole
const CARD_LEN = 3, CARD_TOP = .5, CARD_SPEC = { w: 5, m: .4, type: 'card', v0: 0 };
// Card rules sit just under each typed line's baseline, so the text rests on them. The first is the
// red header rule. They follow the line-space setting, and re-rule from the current line if it changes.
const RULE_OFF = .058;
function cardRules(from, step, keep = []) { const r = keep.slice(); for (let v = from + RULE_OFF; v < CARD_LEN - .12; v += step) r.push(v); return r; }
const cardSpec = step => ({ ...CARD_SPEC, rules: cardRules(CARD_TOP, step) });
const PAPER_TYPES = ['roll', 'fan', 'card'];
const specCols = P => Math.round((P.w - 2 * P.m) / PITCH);
const PHI_P = deg(4), PHI_B = deg(50), PHI_E = deg(64), PHI_IN = deg(-158);
const LEAN = deg(24);                    // paper leans back on its support
const U_EXIT = (PHI_E - PHI_P) * RP;
const U_TEAR = U_EXIT + 0.32;             // tear bar distance above the print line
const TAIL = (PHI_P - PHI_IN) * RP + 2.2;
const JAG_A = 0.035;
const MAX_FEED = ROLL_LEN - TAIL - 0.2;
const DESK_Y = -2.9;
const PRINT_Y = RP * Math.sin(PHI_P), PRINT_Z = RP * Math.cos(PHI_P);
const colX = c => { const P = sheet ? sheet.P : DEFAULT_SPEC; return -P.w / 2 + P.m + (c + 0.5) * PITCH; };
// typing limits follow the paper that's on its way (a queued width/type change), not just the sheet in the machine
let targetP = null, paperChanges = 0;
const COLS_NOW = () => specCols(targetP || (sheet ? sheet.P : DEFAULT_SPEC));
const BELL_NOW = () => COLS_NOW() - 7;
const FONT_PX = 12 / 72 * DPI;            // 12pt Courier = 10 pitch
const BASE_OFF = 0.045 * DPI;

// Paper path: arc length u (0 = print line, + upward/back, - under the platen)
const PATH_STEP = 0.01, U_MIN = -TAIL - 1, U_MAX = ROLL_LEN + 2;
const N_PATH = Math.ceil((U_MAX - U_MIN) / PATH_STEP) + 2;
const PY = new Float32Array(N_PATH), PZ = new Float32Array(N_PATH);
{
  const uIn = (PHI_IN - PHI_P) * RP;
  let y = RP * Math.sin(PHI_E), z = RP * Math.cos(PHI_E), curl = 0, s = 0, uPrev = U_EXIT;
  for (let i = 0; i < N_PATH; i++) {
    const u = U_MIN + i * PATH_STEP;
    if (u <= uIn) {
      const d = uIn - u;
      PY[i] = RP * Math.sin(PHI_IN) - d * Math.cos(PHI_IN);
      PZ[i] = RP * Math.cos(PHI_IN) + d * Math.sin(PHI_IN);
    } else if (u <= U_EXIT) {
      const p = PHI_P + u / RP; PY[i] = RP * Math.sin(p); PZ[i] = RP * Math.cos(p);
    } else {
      const ds = u - uPrev; uPrev = u;
      curl += 0.075 * smooth(2.2, 5.5, s) * ds;
      const beta = Math.min(deg(84), PHI_E + (LEAN - PHI_E) * smooth(0, 1.1, s) + curl);
      y += Math.cos(beta) * ds; z -= Math.sin(beta) * ds; s += ds;
      PY[i] = y; PZ[i] = z;
    }
  }
}
const PT = { y: 0, z: 0 };
function sample(u) {
  const f = (u - U_MIN) / PATH_STEP; let i = Math.floor(f);
  if (i < 0) i = 0; if (i > N_PATH - 2) i = N_PATH - 2;
  const t = f - i; PT.y = PY[i] + (PY[i + 1] - PY[i]) * t; PT.z = PZ[i] + (PZ[i + 1] - PZ[i]) * t; return PT;
}

// ---------------------------------------------------------------- renderer / scene
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// tablets drive a big retina panel with a phone-class GPU: a little less resolution buys a steady frame rate
const TOUCH = navigator.maxTouchPoints > 0 && matchMedia('(any-pointer: coarse)').matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, TOUCH ? 1.25 : 1.5));
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// the lamp's shadow map is redrawn only when something that casts a shadow has moved (see frame())
renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());
// (three 0.169 has no transmissionResolutionScale: the frosted ruler's extra pass is full size, which is
// why tablets get a plainer, cheaper plate below)

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050403);
scene.fog = new THREE.FogExp2(0x050403, 0.03);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.2;

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.5, 200);

// lamp
const lamp = new THREE.SpotLight(0xffd3a0, 820, 0, 0.62, 0.7, 2);
lamp.position.set(-6.5, 12, 8);
lamp.target.position.set(-.8, -.9, 2.2);
lamp.castShadow = true;
lamp.shadow.mapSize.set(2048, 2048);
lamp.shadow.camera.near = 6; lamp.shadow.camera.far = 40;
lamp.shadow.bias = -0.0003; lamp.shadow.normalBias = 0.02;
scene.add(lamp, lamp.target);
const rim = new THREE.DirectionalLight(0x7088b8, 0.22); rim.position.set(8, 6, -10); scene.add(rim);
// faint cool bounce from the room in front-right, so the shell's forms read on the shadow side
const fill = new THREE.DirectionalLight(0x8a98b8, 0.09); fill.position.set(9, 5, 12); scene.add(fill);
const hemi = new THREE.HemisphereLight(0x1d2432, 0x0a0705, 0.35); scene.add(hemi);
// daylight through a window behind and to the left; only there while the sun is up (see applyDaylight)
const windowLight = new THREE.DirectionalLight(0xbcd0ff, 0); windowLight.position.set(-14, 16, -18); scene.add(windowLight);
// a soft pool of light that follows your gaze across the desk, so paper far from the lamp stays legible
const roamLight = new THREE.PointLight(0xffe2bf, 0, 0, 2); scene.add(roamLight);
// A sheet held up to read is drawn in its own pass on top of the room (depth cleared between), so it
// is fully opaque and nothing in the scene can cut into it. The room behind dims slightly.
const heldScene = new THREE.Scene();
heldScene.environment = scene.environment; heldScene.environmentIntensity = .35;
{
  const key = new THREE.DirectionalLight(0xffe4c4, 2.1); key.position.set(-5, 9, 7); heldScene.add(key);
  heldScene.add(new THREE.HemisphereLight(0xfff4e6, 0x2a2622, .55));
}
const dimScene = new THREE.Scene(), dimCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const dimMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
dimScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dimMat));

// ---------------------------------------------------------------- procedural textures
function paperTile() {
  const S = 512, c = mkCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#f2ede1'; g.fillRect(0, 0, S, S);
  const wraps = [-S, 0, S];
  for (let i = 0; i < 80; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 20 + Math.random() * 90, dark = Math.random() < .55;
    for (const ox of wraps) for (const oy of wraps) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, dark ? 'rgba(150,128,96,0.035)' : 'rgba(255,255,250,0.05)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
    }
  }
  g.lineCap = 'round';
  for (let i = 0; i < 300; i++) {
    const x = Math.random() * S, y = Math.random() * S, l = 6 + Math.random() * 22, a = Math.random() * TAU;
    const cx = (Math.random() - .5) * 7, cy = (Math.random() - .5) * 7;
    g.strokeStyle = Math.random() < .7 ? 'rgba(120,98,72,0.07)' : 'rgba(255,255,255,0.14)';
    g.lineWidth = .5 + Math.random() * .6;
    for (const ox of wraps) for (const oy of wraps) {
      g.beginPath(); g.moveTo(x + ox, y + oy);
      g.quadraticCurveTo(x + ox + Math.cos(a) * l / 2 + cx, y + oy + Math.sin(a) * l / 2 + cy, x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l);
      g.stroke();
    }
  }
  const id = g.getImageData(0, 0, S, S), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - .5) * 9; d[i] += n; d[i + 1] += n; d[i + 2] += n * .9; }
  g.putImageData(id, 0, 0);
  return c;
}
const PAPER_TILE = paperTile();
const patterns = new WeakMap();
const paperPattern = ctx => { let p = patterns.get(ctx); if (!p) { p = ctx.createPattern(PAPER_TILE, 'repeat'); patterns.set(ctx, p); } return p; };

function woodTexture() {
  const S = 1024, c = mkCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#20140c'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 340; i++) {
    const y0 = Math.random() * S, k = 1 + (Math.random() * 3 | 0), a = 4 + Math.random() * 18, ph = Math.random() * TAU;
    const light = Math.random() < .5;
    g.strokeStyle = light ? `rgba(120,78,44,${.05 + Math.random() * .12})` : `rgba(8,4,2,${.08 + Math.random() * .2})`;
    g.lineWidth = .6 + Math.random() * 3.2;
    g.beginPath();
    for (let x = -8; x <= S + 8; x += 8) {
      const y = y0 + Math.sin(x / S * TAU * k + ph) * a + Math.sin(x / S * TAU * 7 + ph * 2) * 1.5;
      x < 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  }
  const id = g.getImageData(0, 0, S, S), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - .5) * 10; d[i] += n; d[i + 1] += n * .8; d[i + 2] += n * .6; }
  g.putImageData(id, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2.2); t.anisotropy = MAX_ANISO; return t;
}

function rubberTexture() {
  const c = mkCanvas(1024, 64), g = c.getContext('2d');
  g.fillStyle = '#161616'; g.fillRect(0, 0, 1024, 64);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = Math.random() < .5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.25)';
    g.fillRect(Math.random() * 1024, Math.random() * 64, 1 + Math.random() * 3, 1 + Math.random() * 20);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------------------------------------------------------------- materials
const M_rubber = new THREE.MeshStandardMaterial({ map: rubberTexture(), roughness: .72, metalness: 0 });
const M_chrome = new THREE.MeshStandardMaterial({ color: 0xd0d3d8, roughness: .22, metalness: 1 });
const M_frame = new THREE.MeshStandardMaterial({ color: 0x19191b, roughness: .62, metalness: .35 });
const M_plastic = new THREE.MeshStandardMaterial({ color: 0x1d1d20, roughness: .5, metalness: 0 });
const M_beige = new THREE.MeshStandardMaterial({ color: 0x2a2826, roughness: .55, metalness: 0 });
const M_knob = new THREE.MeshStandardMaterial({ color: 0x121213, roughness: .42, metalness: 0 });

// ---------------------------------------------------------------- room
{
  const wood = woodTexture(); wood.repeat.set(4000 / 30, 4000 / 27);
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshPhysicalMaterial({ map: wood, roughness: .62, metalness: 0, clearcoat: .25, clearcoatRoughness: .45 }));
  desk.rotation.x = -Math.PI / 2; desk.position.set(0, DESK_Y, 4); desk.receiveShadow = true; scene.add(desk);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(120, 60), new THREE.MeshStandardMaterial({ color: 0x0c0a09, roughness: 1 }));
  wall.position.set(0, 10, -24); scene.add(wall);
}

// ---------------------------------------------------------------- the mechanism
const machine = new THREE.Group(); scene.add(machine);

// The body covers the mechanism, Typestar-style: a sloped front deck, side housings and a rear
// cover. What stays exposed is the paper slot, the platen knobs, and a smoked clear paper-guide
// plate at the print line, through which the carriage (thermal head, film ribbon, cassette) is seen.
// satin ABS: a soft diffuse base under a thin, slightly blurred clear coat that catches the lamp on every bevel
const M_body = new THREE.MeshPhysicalMaterial({ color: 0x262422, roughness: .62, metalness: 0, clearcoat: .35, clearcoatRoughness: .32, sheen: .15, sheenRoughness: .6, sheenColor: new THREE.Color(0x3a342c) });
const M_bodyDark = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: .7, metalness: 0 });
// One top shell, Typestar-style. Seen from the side it is a single profile: a front lip, a deck that
// rises toward the paper (the LCD is set into it), the clear ruler lying flush in the same surface,
// the paper slot, and a raised rear section. Across the paper width the ruler is a window onto a
// well that holds the carriage; at both ends solid caps close the profile so it reads as one body.
const GUIDE_TOP = new THREE.Vector3(0, PRINT_Y + .03, PRINT_Z + .09);   // back edge of the ruler, at the print line
const GUIDE_LEAN = deg(60), GUIDE_H = 1.25;                             // lies back 30° from horizontal
const RULER_FRONT = { y: GUIDE_TOP.y - GUIDE_H * Math.cos(GUIDE_LEAN), z: GUIDE_TOP.z + GUIDE_H * Math.sin(GUIDE_LEAN) };
const DECK_FRONT = { y: -1.96, z: 5.45 };
const deckY = z => RULER_FRONT.y + (z - RULER_FRONT.z) * (DECK_FRONT.y - RULER_FRONT.y) / (DECK_FRONT.z - RULER_FRONT.z);
const DECK_TILT = Math.atan2(RULER_FRONT.y - DECK_FRONT.y, DECK_FRONT.z - RULER_FRONT.z);
const REAR = { front: -.3, top: 1.0, back: -3.35 };
function extrudeProfile(pts, x0, x1, bevel = 0) {
  const shape = new THREE.Shape(); pts.forEach(([z, y], i) => i ? shape.lineTo(z, y) : shape.moveTo(z, y)); shape.closePath();
  const bt = bevel, depth = x1 - x0 - 2 * bt;
  // bevelOffset pulls the bevel inside the profile, so a bevelled cap is flush with the unbevelled body
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bt, bevelSize: bevel * .8, bevelOffset: -bevel * .8, bevelSegments: 4, curveSegments: 6 });
  g.rotateY(-Math.PI / 2); g.translate(x1 - bt, 0, 0); g.computeVertexNormals(); return g;
}
{
  const F = DECK_FRONT, RF = RULER_FRONT, B = GUIDE_TOP, base = DESK_Y + .02;
  // front section: lip → deck up to the ruler's front edge, then down into the carriage well
  const front = [[F.z + .08, base], [F.z + .12, F.y - .2], [F.z, F.y], [RF.z, RF.y], [RF.z - .02, -1.2], [.15, -1.2], [.15, base]];
  // rear section behind the paper slot
  const rear = [[REAR.front, base], [REAR.front, REAR.top - .3], [REAR.front - .25, REAR.top], [REAR.back + .3, REAR.top + .04], [REAR.back, REAR.top - .3], [REAR.back, base]];
  // end caps: the full closed profile, bridging over the slot beside the paper
  const cap = [[F.z + .08, base], [F.z + .12, F.y - .2], [F.z, F.y], [RF.z, RF.y], [B.z, B.y], [.62, .92], [REAR.front - .25, REAR.top], [REAR.back + .3, REAR.top + .04], [REAR.back, REAR.top - .3], [REAR.back, base]];
  const add = (g, m = M_body) => { const mesh = new THREE.Mesh(g, m); mesh.castShadow = mesh.receiveShadow = true; machine.add(mesh); return mesh; };
  add(extrudeProfile(front, -5.5, 5.5));
  add(extrudeProfile(rear, -5.5, 5.5));
  add(extrudeProfile(cap, 5.36, 6.06, .09));
  add(extrudeProfile(cap, -6.06, -5.36, .09));
  // soft contact shadow where the machine meets the desk
  {
    const c = mkCanvas(256, 256), g = c.getContext('2d');
    const gr = g.createRadialGradient(128, 128, 20, 128, 128, 128); gr.addColorStop(0, 'rgba(0,0,0,.75)'); gr.addColorStop(.6, 'rgba(0,0,0,.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    const ao = new THREE.Mesh(new THREE.PlaneGeometry(15.5, 11.5), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    ao.rotation.x = -Math.PI / 2; ao.position.set(0, DESK_Y + .004, 1.0); machine.add(ao);
  }
  // inside of the well: dark, so the carriage reads against shadow
  const well = new THREE.Mesh(new THREE.PlaneGeometry(10.72, RF.z - .15), M_bodyDark);
  well.rotation.x = -Math.PI / 2; well.position.set(0, -1.19, (RF.z + .15) / 2); machine.add(well);
  const wallF = new THREE.Mesh(new THREE.PlaneGeometry(10.72, RF.y + 1.2), M_bodyDark);
  wallF.position.set(0, (RF.y - 1.2) / 2, RF.z - .025); wallF.rotation.y = Math.PI; machine.add(wallF);
  // a dark reveal line where the paper slot meets the rear section
  const lip = new THREE.Mesh(new THREE.BoxGeometry(10.72, .04, .06), M_bodyDark); lip.position.set(0, REAR.top - .02, REAR.front - .2); machine.add(lip);
  // rear paper support
  const sup = new THREE.Mesh(new RoundedBoxGeometry(9.0, 2.2, .06, 2, .02),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: .7, metalness: 0 }));
  sample(U_EXIT + 1.2);
  sup.position.set(0, PT.y - .05, PT.z - .12); sup.rotation.x = -LEAN; sup.receiveShadow = true; machine.add(sup);
}

// platen + knobs (the platen itself is mostly hidden under the covers)
const platenRot = new THREE.Group(); machine.add(platenRot);
{
  const g = new THREE.CylinderGeometry(R, R, 10.7, 160, 1); g.rotateZ(Math.PI / 2);
  const platen = new THREE.Mesh(g, M_rubber); platen.castShadow = platen.receiveShadow = true; platenRot.add(platen);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(.09, .09, 13.4, 16).rotateZ(Math.PI / 2), M_chrome); platenRot.add(shaft);
  for (const sx of [-1, 1]) {
    const kg = new THREE.CylinderGeometry(.66, .66, .5, 180, 3);
    const p = kg.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z);
      if (r > .6) { const a = Math.atan2(z, x); const k = .62 + .04 * Math.pow(Math.abs(Math.cos(a * 18)), .6); p.setX(i, Math.cos(a) * k); p.setZ(i, Math.sin(a) * k); }
    }
    kg.computeVertexNormals(); kg.rotateZ(Math.PI / 2);
    const knob = new THREE.Mesh(kg, M_knob); knob.position.x = sx * 6.36; knob.castShadow = true; platenRot.add(knob);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(.3, .3, .52, 40).rotateZ(Math.PI / 2), M_chrome);
    cap.position.x = sx * 6.37; platenRot.add(cap);
    const tick = new THREE.Mesh(new THREE.BoxGeometry(.06, .04, .2), new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: .4 }));
    tick.position.set(sx * 6.63, .45, 0); platenRot.add(tick);
  }
}
// paper release lever (right housing)
{
  const lever = new THREE.Mesh(new RoundedBoxGeometry(.14, .9, .22, 2, .05), M_frame);
  lever.position.set(5.74, 1.28, -2.45); lever.rotation.x = -.45; lever.castShadow = true; machine.add(lever);
  const tip = new THREE.Mesh(new RoundedBoxGeometry(.24, .28, .34, 3, .08), M_knob); tip.position.set(5.74, 1.7, -2.67); machine.add(tip);
}

// frosted acrylic ruler: the mechanism shows through it softened (~60%), with a crisp printed scale on top
const guide = new THREE.Group(); guide.position.copy(GUIDE_TOP); guide.rotation.x = -GUIDE_LEAN; machine.add(guide);
const RULER_X0 = -5.2;                        // the scale reads 0 at the plate's left end, like a typewriter scale
const marginTabs = [];
{
  const W = 10.72, S = 4096, H = Math.round(S * GUIDE_H / W), pxIn = S / W;
  const c = mkCanvas(S, H), g = c.getContext('2d');
  // polished top edge
  g.fillStyle = 'rgba(255,255,255,0.28)'; g.fillRect(0, 0, S, 4);
  const X = col => (RULER_X0 + col * PITCH + W / 2) * pxIn;
  // moulded guide ribs every ten columns
  for (let col = 0; col <= 100; col += 10) { g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(X(col) - 1.5, 30, 3, H * .5); }
  const y0 = H * .64;
  g.fillStyle = 'rgba(240,236,224,0.9)'; g.font = `500 ${Math.round(H * .11)}px "IBM Plex Mono", monospace`; g.textAlign = 'center';
  for (let col = 0; col <= 104; col++) {
    const x = X(col), big = col % 10 === 0, mid = col % 5 === 0;
    g.fillRect(x - 1.4, y0, 2.8, big ? H * .12 : mid ? H * .08 : H * .045);
    if (big) g.fillText(String(col), x, y0 + H * .25);
  }
  g.fillStyle = 'rgba(240,236,224,0.55)'; g.fillRect(0, y0 - 2, S, 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO;
  // the acrylic body: rough transmission blurs what's beneath, a clear coat keeps the surface glossy
  // Tablets skip transmission: it re-renders the whole scene behind the plate every frame. A smoked,
  // glossy translucent plate reads almost the same from the typing position at a fraction of the cost.
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, GUIDE_H, .06), TOUCH
    ? new THREE.MeshPhysicalMaterial({ color: 0x8f959b, transparent: true, opacity: .62, roughness: .35, clearcoat: 1, clearcoatRoughness: .05, specularIntensity: .6, depthWrite: false })
    : new THREE.MeshPhysicalMaterial({
      color: 0xb4bac0, transmission: 1, roughness: .3, thickness: .12, ior: 1.49,
      clearcoat: 1, clearcoatRoughness: .05, specularIntensity: .6, attenuationColor: new THREE.Color(0x60666c), attenuationDistance: 1.6,
    }));
  body.position.set(0, -GUIDE_H / 2, -.03); guide.add(body);
  const print = new THREE.Mesh(new THREE.PlaneGeometry(W, GUIDE_H),
    new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: .3, depthWrite: false }));
  print.position.set(0, -GUIDE_H / 2, .002); print.renderOrder = 5; guide.add(print);
  // red margin tabs: slide with the paper width
  const tri = new THREE.Shape(); tri.moveTo(-.06, .07); tri.lineTo(.06, .07); tri.lineTo(0, -.03); tri.closePath();
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Mesh(new THREE.ShapeGeometry(tri), new THREE.MeshStandardMaterial({ color: 0xd2412c, roughness: .4 }));
    m.position.set(0, -GUIDE_H * .6, .006); guide.add(m); marginTabs.push(m);
  }
}

// carriage behind the plate: thermal head at the print point, film ribbon, cassette with reels
const carrier = new THREE.Group(); machine.add(carrier);
const head = new THREE.Group(); head.position.set(0, PRINT_Y, PRINT_Z); head.rotation.x = -PHI_P; carrier.add(head);
const headBlock = new THREE.Group(); head.add(headBlock);
const headDotsMat = new THREE.MeshBasicMaterial({ color: 0x5a2a18 });   // the 26-dot heater line; glows while burning        // moves onto the platen when locked
const reels = [];
{
  const ceramic = new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: .35 });
  const strip = new THREE.Mesh(new RoundedBoxGeometry(.13, .3, .06, 2, .015), ceramic);
  strip.position.set(0, -.1, .07); headBlock.add(strip);
  const dots = new THREE.Mesh(new THREE.PlaneGeometry(.02, .26), headDotsMat);
  dots.position.set(0, -.1, .101); headBlock.add(dots);
  const mount = new THREE.Mesh(new RoundedBoxGeometry(.42, .5, .22, 3, .05), M_frame);
  mount.position.set(0, -.42, .2); headBlock.add(mount);   // no shadow: it sits in the dark well, and it moves on every printed frame
  // film ribbon: comes up from the cassette, wraps the head face, goes back down
  const film = new THREE.MeshStandardMaterial({ color: 0x09090b, roughness: .18, metalness: .3, side: THREE.DoubleSide });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(.62, .34), film); face.position.set(.12, -.1, .03); headBlock.add(face);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.PlaneGeometry(.1, .62), film);
    leg.position.set(.12 + sx * .31, -.42, .12); leg.rotation.y = sx * .9; headBlock.add(leg);
  }
}
const cassette = new THREE.Group(); carrier.add(cassette);
{
  // parallel to the plate, set just behind it
  cassette.position.copy(GUIDE_TOP); cassette.rotation.x = -GUIDE_LEAN;
  const W = 2.1, H = .62;
  const c = mkCanvas(1024, 304), g = c.getContext('2d');
  g.fillStyle = '#232326'; g.beginPath(); g.roundRect(0, 0, 1024, 304, 26); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 4; g.stroke();
  for (const cx of [250, 774]) { g.fillStyle = '#0c0c0e'; g.beginPath(); g.arc(cx, 152, 112, 0, TAU); g.fill(); g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 3; g.stroke(); }
  g.fillStyle = 'rgba(210,205,192,.55)'; g.font = '600 28px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillText('THERMAL TRANSFER', 512, 150);
  g.fillStyle = 'rgba(210,205,192,.3)'; g.font = '500 22px "IBM Plex Mono", monospace'; g.fillText('FILM · BLACK', 512, 186);
  g.fillStyle = '#c8452f'; g.fillRect(506, 16, 12, 60);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO;
  const shell = new THREE.Mesh(new RoundedBoxGeometry(W, H, .16, 3, .05),
    [M_plastic, M_plastic, M_plastic, M_plastic, new THREE.MeshStandardMaterial({ map: t, roughness: .45 }), M_plastic]);
  shell.position.set(.12, -.86, -.2); cassette.add(shell);
  for (const sx of [-1, 1]) {
    const reel = new THREE.Group(); reel.position.set(.12 + sx * W * .256, -.86, -.115); cassette.add(reel);
    const r = sx < 0 ? .19 : .13;
    const wound = new THREE.Mesh(new THREE.CylinderGeometry(r, r, .03, 40).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: .2, metalness: .5 }));
    reel.add(wound);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(.075, .075, .04, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd6d0c2, roughness: .5 }));
    reel.add(hub);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(.13, .018, .045), new THREE.MeshStandardMaterial({ color: 0x5a564f }));
    reel.add(spoke);
    reels.push(reel);
  }
  // carriage pointer: reads against the plate's scale
  const ptr = new THREE.Mesh(new THREE.PlaneGeometry(.028, .22), new THREE.MeshBasicMaterial({ color: 0xe0452e }));
  ptr.position.set(0, -.62, -.1); cassette.add(ptr);
}

// ---------------------------------------------------------------- LCD
const LCD_W = 1300, LCD_H = 132, LCD_CELLS = 31;
const lcdCanvas = mkCanvas(LCD_W, LCD_H), lcdCtx = lcdCanvas.getContext('2d');
const lcdTex = new THREE.CanvasTexture(lcdCanvas); lcdTex.colorSpace = THREE.SRGBColorSpace; lcdTex.anisotropy = MAX_ANISO;
// ---- the deck: everything printed on the body, controls set into it --------------------------
// deckG is a frame lying on the sloped deck: x across, +z down the slope toward you, +y out of the surface.
const DECK_Z0 = 2.2, DECK_L = (5.32 - DECK_Z0) / Math.cos(DECK_TILT);
const deckG = new THREE.Group(); deckG.position.set(0, deckY(DECK_Z0), DECK_Z0); deckG.rotation.x = DECK_TILT; machine.add(deckG);
const LCD_V = .84;                              // display centre, distance down the slope
const CTRL_V = .8, PAPER_X = -4.3, SPACE_X = 4.3;
const controls = [];                            // clickable hit volumes
let feedSpacing = 0;                           // the spacing the platen actually uses (applied in queue order)
const ctl = { paper: 0, paperS: 0, spacing: 0, leverS: 0, wi: 0, dialS: 0, guideW: 8.5 };
const INK = '#d9d3c4', DIM = '#8a857b', RED = '#c8452f';
function printCanvas(wIn, hIn, ppi, draw) {
  const c = mkCanvas(wIn * ppi, hIn * ppi), g = c.getContext('2d'); g.scale(ppi, ppi); draw(g);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO; return t;
}
function label(g, text, x, y, size, color = INK, align = 'center', weight = 600) {
  g.font = `${weight} ${size}px "IBM Plex Mono", monospace`; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(text, x, y);
}
function keyLegend(g, items, cx, y, size) {
  // measure then centre a row of  KEY label  pairs
  g.font = `600 ${size}px "IBM Plex Mono", monospace`;
  const gap = size * 2.2, parts = items.map(([k, v]) => { g.font = `600 ${size}px "IBM Plex Mono", monospace`; const kw = g.measureText(k).width + size * .8; g.font = `500 ${size}px "IBM Plex Mono", monospace`; return { k, v, kw, vw: g.measureText(v).width }; });
  let x = cx - (parts.reduce((a, p) => a + p.kw + size * .6 + p.vw, 0) + gap * (parts.length - 1)) / 2;
  for (const p of parts) {
    g.strokeStyle = 'rgba(217,211,196,.45)'; g.lineWidth = size * .08; g.beginPath(); g.roundRect(x, y - size * .72, p.kw, size * 1.44, size * .25); g.stroke();
    label(g, p.k, x + p.kw / 2, y + size * .04, size, INK);
    label(g, p.v, x + p.kw + size * .6, y + size * .04, size, DIM, 'left', 500);
    x += p.kw + size * .6 + p.vw + gap;
  }
}
{
  // printed deck graphics, drawn in inches (u across from -6, v down the slope)
  const W = 12, ppi = 220;
  const tex = printCanvas(W, DECK_L, ppi, g => {
    g.translate(W / 2, 0);
    // a fine moulded groove along the ruler's front edge
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(-5.3, .025, 10.6, .012); g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(-5.3, .039, 10.6, .01);
    // LCD recess: dark well with a shadowed upper lip and a lit lower lip
    const lw = 6.5, lh = 1.12, ly = LCD_V - lh / 2;
    g.fillStyle = '#0c0c0c'; g.beginPath(); g.roundRect(-lw / 2, ly, lw, lh, .1); g.fill();
    const gi = g.createLinearGradient(0, ly, 0, ly + lh); gi.addColorStop(0, 'rgba(0,0,0,.9)'); gi.addColorStop(.25, 'rgba(0,0,0,0)'); gi.addColorStop(1, 'rgba(255,255,255,.05)');
    g.fillStyle = gi; g.beginPath(); g.roundRect(-lw / 2, ly, lw, lh, .1); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = .014; g.beginPath(); g.moveTo(-lw / 2 + .1, ly + lh + .008); g.lineTo(lw / 2 - .1, ly + lh + .008); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,.8)'; g.lineWidth = .02; g.beginPath(); g.moveTo(-lw / 2 + .1, ly - .01); g.lineTo(lw / 2 - .1, ly - .01); g.stroke();
    label(g, 'LINE MEMORY · 31 CH', -lw / 2 + .1, ly - .085, .07, DIM, 'left', 500);
    label(g, 'THERMAL TRANSFER', lw / 2 - .1, ly - .085, .07, DIM, 'right', 500);
    // PAPER switch: slot + labels
    g.fillStyle = '#0b0b0b'; g.beginPath(); g.roundRect(PAPER_X - .52, CTRL_V - .07, 1.04, .14, .07); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.1)'; g.lineWidth = .01; g.stroke();
    label(g, 'ROLL', PAPER_X - .36, CTRL_V - .24, .08); label(g, 'FAN', PAPER_X, CTRL_V - .24, .08); label(g, 'CARD', PAPER_X + .36, CTRL_V - .24, .08);
    for (const dx of [-.36, 0, .36]) { g.fillStyle = 'rgba(217,211,196,.5)'; g.fillRect(PAPER_X + dx - .004, CTRL_V - .16, .008, .05); }
    label(g, 'PAPER', PAPER_X, CTRL_V + .27, .1, INK); label(g, 'ALT P', PAPER_X, CTRL_V + .41, .07, DIM, 'center', 500);
    // LINE SPACE lever marks (pivot below, arc above)
    const pv = CTRL_V + .16;
    SPACINGS.forEach((sp, i) => {
      const a = (i - 1) * .62, x = SPACE_X + Math.sin(a) * .42, y = pv - Math.cos(a) * .42;
      g.fillStyle = INK; g.beginPath(); g.arc(SPACE_X + Math.sin(a) * .3, pv - Math.cos(a) * .3, .018, 0, TAU); g.fill();
      label(g, ['1', '1½', '2'][i], x, y, .1);
    });
    g.fillStyle = '#0b0b0b'; g.beginPath(); g.arc(SPACE_X, pv, .1, 0, TAU); g.fill();
    label(g, 'LINE SPACE', SPACE_X, CTRL_V + .35, .1, INK); label(g, 'ALT S', SPACE_X, CTRL_V + .49, .07, DIM, 'center', 500);
    // key legend: every shortcut lives on the body
    keyLegend(g, [['RETURN', 'PRINT LINE'], ['⌫', 'CORRECT'], ['CTRL B', 'BOLD'], ['CTRL U', 'UNDERLINE'], ['CTRL M', 'LINE / CHAR']], 0, 1.66, .082);
    keyLegend(g, [['CTRL X', 'TEAR · EJECT CARD'], ['ALT T', 'TIDY DESK'], ['ALT M', 'SOUND'], ['ESC', 'TYPING']], 0, 1.95, .082);
    g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(-5.4, 2.2, 10.8, .01);
    keyLegend(g, [['SCROLL', 'VIEWS'], ['DRAG', 'MOVE SCRAP · PAN DESK'], ['CLICK', 'READ'], ['BIN', 'DROP IN TO DISCARD']], 0, 2.44, .074);
    // name plate
    // the badge: the platen end-on, a red roller with its shaft, beside the name
    g.fillStyle = '#c8452f'; g.beginPath(); g.arc(-4.93, 2.855, .085, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(246,240,228,.85)'; g.lineWidth = .008; g.beginPath(); g.arc(-4.93, 2.855, .02, 0, TAU); g.stroke();
    label(g, 'PLATEN', -4.78, 2.86, .13, INK, 'left', 600);
    label(g, 'LM-31 · THERMAL LINE MEMORY', 5.05, 2.86, .075, DIM, 'right', 500);
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(W, DECK_L), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: .5, depthWrite: false }));
  plane.rotation.x = -Math.PI / 2; plane.position.set(0, .002, DECK_L / 2); plane.receiveShadow = true; deckG.add(plane);
}
// LCD, set into its recess
const lcdGroup = new THREE.Group(); deckG.add(lcdGroup);
{
  lcdGroup.position.set(0, .009, LCD_V); lcdGroup.rotation.x = -Math.PI / 2;
  const lcd = new THREE.Mesh(new THREE.PlaneGeometry(5.8, 5.8 * LCD_H / LCD_W),
    new THREE.MeshStandardMaterial({ map: lcdTex, emissive: 0xffffff, emissiveMap: lcdTex, emissiveIntensity: .3, roughness: .7 }));
  lcdGroup.add(lcd);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(6.3, 1.0),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: .06, roughness: .04, clearcoat: 1, depthWrite: false }));
  glass.position.z = .004; lcdGroup.add(glass);
}
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
function hitBox(w, h, d, name, parent, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), hitMat); m.position.set(x, y, z); m.userData.control = name; parent.add(m); controls.push(m); return m; }
// PAPER slide switch
const paperKnob = new THREE.Mesh(new RoundedBoxGeometry(.3, .12, .2, 3, .04), new THREE.MeshPhysicalMaterial({ color: 0x1a1a1a, roughness: .35, clearcoat: .5 }));
paperKnob.castShadow = true; deckG.add(paperKnob);
{ const ridge = new THREE.Mesh(new THREE.BoxGeometry(.03, .02, .15), new THREE.MeshStandardMaterial({ color: 0xd2412c, roughness: .4 })); ridge.position.y = .065; paperKnob.add(ridge); }
hitBox(1.3, .3, .8, 'paper', deckG, PAPER_X, .1, CTRL_V);
// LINE SPACE lever
const spaceLever = new THREE.Group(); spaceLever.position.set(SPACE_X, .02, CTRL_V + .16); deckG.add(spaceLever);
{
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(.09, .1, .08, 32), new THREE.MeshStandardMaterial({ color: 0x9da1a5, roughness: .25, metalness: 1 }));
  hub.position.y = .04; spaceLever.add(hub);
  const arm = new THREE.Mesh(new RoundedBoxGeometry(.075, .05, .36, 2, .02), new THREE.MeshPhysicalMaterial({ color: 0x1a1a1a, roughness: .35, clearcoat: .5 }));
  arm.position.set(0, .07, -.18); arm.castShadow = true; spaceLever.add(arm);
  const tip = new THREE.Mesh(new THREE.BoxGeometry(.03, .012, .1), new THREE.MeshStandardMaterial({ color: 0xd2412c })); tip.position.set(0, .1, -.3); spaceLever.add(tip);
}
hitBox(1.1, .3, 1.0, 'spacing', deckG, SPACE_X, .1, CTRL_V - .05);
// WIDTH dial on the right end cap, with the paper guides in the slot
const capTopY = z => 1.0 + .04 * ((-.55 - z) / 2.5);
const DIAL_Z = -1.05;
const widthDial = new THREE.Group(); widthDial.position.set(5.71, capTopY(DIAL_Z), DIAL_Z); machine.add(widthDial);
{
  const kg = new THREE.CylinderGeometry(.17, .18, .12, 96, 2), p = kg.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z); if (r > .15) { const a = Math.atan2(z, x), k = (r > .175 ? .18 : .17) + .008 * Math.pow(Math.abs(Math.cos(a * 14)), .6); p.setX(i, Math.cos(a) * k); p.setZ(i, Math.sin(a) * k); } }
  kg.computeVertexNormals();
  const knob = new THREE.Mesh(kg, new THREE.MeshPhysicalMaterial({ color: 0x151515, roughness: .4, clearcoat: .4 })); knob.position.y = .06; knob.castShadow = true; widthDial.add(knob);
  const ptr = new THREE.Mesh(new THREE.BoxGeometry(.025, .01, .12), new THREE.MeshBasicMaterial({ color: 0xe8e2d4 })); ptr.position.set(0, .125, .08); widthDial.add(ptr);
  const tex = printCanvas(.62, 1.5, 400, g => {
    g.translate(.31, .6);
    WIDTHS.forEach((wd, i) => { const a = (i - 1) * .75, x = Math.sin(a) * .27, y = Math.cos(a) * .27; label(g, wd.label, x, y, .075); });
    label(g, 'WIDTH', 0, -.3, .07, INK); label(g, 'ALT W', 0, -.4, .05, DIM, 'center', 500);
    label(g, 'IN.', 0, .42, .05, DIM, 'center', 500);
  });
  const pl = new THREE.Mesh(new THREE.PlaneGeometry(.62, 1.5), new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: .5 }));
  pl.rotation.x = -Math.PI / 2; pl.position.set(5.71, capTopY(DIAL_Z) + .003, DIAL_Z + .15); machine.add(pl);
  hitBox(.6, .4, .7, 'width', machine, 5.71, capTopY(DIAL_Z) + .1, DIAL_Z);
  // platen legend on the left cap, next to the knob it describes
  const tex2 = printCanvas(.62, 1.1, 400, g => {
    g.translate(.31, .55);
    label(g, 'PLATEN', 0, -.2, .07, INK); label(g, '▲ PG UP', 0, -.05, .06, DIM, 'center', 500); label(g, '▼ PG DN', 0, .07, .06, DIM, 'center', 500);
  });
  const pl2 = new THREE.Mesh(new THREE.PlaneGeometry(.62, 1.1), new THREE.MeshStandardMaterial({ map: tex2, transparent: true, depthWrite: false, roughness: .5 }));
  pl2.rotation.x = -Math.PI / 2; pl2.position.set(-5.71, capTopY(DIAL_Z) + .003, DIAL_Z); machine.add(pl2);
}
const paperGuides = [];
for (const sx of [-1, 1]) {
  const f = new THREE.Mesh(new RoundedBoxGeometry(.06, .3, .34, 2, .02), new THREE.MeshPhysicalMaterial({ color: 0x1c1c1c, roughness: .4, clearcoat: .4 }));
  f.castShadow = true; f.position.set(sx * 4.3, 1.14, -.46); machine.add(f);
  const line = new THREE.Mesh(new THREE.BoxGeometry(.062, .01, .2), new THREE.MeshBasicMaterial({ color: 0xe8e2d4 })); line.position.y = .15; f.add(line);
  paperGuides.push(f);
}
function updateControls(dt) {
  const k = 1 - Math.exp(-dt * 14);
  ctl.paperS += (ctl.paper - ctl.paperS) * k;
  ctl.leverS += (ctl.spacing - ctl.leverS) * k;
  ctl.dialS += (ctl.wi - ctl.dialS) * k;
  paperKnob.position.set(PAPER_X - .36 + .36 * ctl.paperS, .06, CTRL_V);
  spaceLever.rotation.y = -(ctl.leverS - 1) * .62;
  widthDial.rotation.y = (ctl.dialS - 1) * .75;
  const guidesMoved = Math.abs(paperGuides[1].position.x - (ctl.guideW / 2 + .04)) > 1e-4;
  paperGuides[0].position.x = -ctl.guideW / 2 - .04; paperGuides[1].position.x = ctl.guideW / 2 + .04;
  const P = sheet ? sheet.P : DEFAULT_SPEC, cols = specCols(P);
  const lx = -P.w / 2 + P.m, rx = lx + cols * PITCH;
  marginTabs[0].position.x += (lx - marginTabs[0].position.x) * k;
  marginTabs[1].position.x += (rx - marginTabs[1].position.x) * k;
  return guidesMoved || Math.abs(ctl.paper - ctl.paperS) > 1e-3 || Math.abs(ctl.spacing - ctl.leverS) > 1e-3 || Math.abs(ctl.wi - ctl.dialS) > 1e-3
    || Math.abs(lx - marginTabs[0].position.x) > 1e-3 || Math.abs(rx - marginTabs[1].position.x) > 1e-3;
}




// ---------------------------------------------------------------- tweens
const tweens = [];
let NOW = performance.now() / 1000;
function tween(dur, fn, ease = easeInOut) { return new Promise(res => tweens.push({ t0: performance.now() / 1000, dur: Math.max(dur, 1e-4), fn, ease, res })); }
function tweenProp(obj, key, to, dur, ease = easeInOut) { const from = obj[key]; return tween(dur, e => { obj[key] = from + (to - from) * e; }, ease); }
const wait = s => tween(s, () => { }, linear);
function updateTweens() {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]; const t = clamp((NOW - tw.t0) / tw.dur, 0, 1);
    try { tw.fn(tw.ease(t)); } catch (e) { console.error(e); tweens.splice(i, 1); tw.res(); continue; }   // never let one tween stall everything
    if (t >= 1) { tweens.splice(i, 1); tw.res(); }
  }
}

// ---------------------------------------------------------------- ink
const glyphCanvas = mkCanvas(48, 56), gctx = glyphCanvas.getContext('2d');
const liftCanvas = mkCanvas(48, 56), lctx = liftCanvas.getContext('2d');
// ---- head temperature. A thermal head carries heat from one character to the next. After a pause it
// starts cold: the film doesn't fully melt, so letters come out a little faint with more voids. In a dense
// run it warms up and prints a touch darker, with edges that spread slightly. Each character keeps the
// heat it was printed at (op.h, 0 cold … 1 hot), so a page never changes once it's printed.
const HEAT = { H: 0, t: 0 }, HEAT_TAU = 3.2, HEAT_PER = .2;
function headHeat() { const now = performance.now() / 1000; HEAT.H *= Math.exp(-(now - HEAT.t) / HEAT_TAU); HEAT.t = now; return HEAT.H; }
function burnHeat(op, energy = op.w) { const H = headHeat(); if (op) op.h = Math.round((1 - Math.exp(-H / 1.8)) * 9) / 9; HEAT.H = H + HEAT_PER * energy; }
const heatDensity = op => op.h == null ? 1 : 1 + (op.h - .75) * .26;             // cold .80 … hot 1.07
const heatCold = op => op.h == null ? 0 : clamp((.55 - op.h) / .55, 0, 1);
function hammerWeight(ch) {
  if ('.,\'`:;-_"’‘'.includes(ch)) return .38;
  if ('MWmw@#%&BQNHGOD$'.includes(ch)) return 1;
  if (/[A-Z0-9]/.test(ch)) return .84;
  return .7;
}
function drawOp(ctx, op, ox = 0, oy = 0, m = 1) {
  const r = rng(op.seed);
  gctx.globalCompositeOperation = 'source-over'; gctx.globalAlpha = 1;
  gctx.clearRect(0, 0, 48, 56);
  gctx.save();
  gctx.translate(24, 38); gctx.rotate((r() - .5) * .014);
  gctx.font = `${FONT_PX}px "Courier Prime", "Courier New", monospace`;
  gctx.textAlign = 'center'; gctx.textBaseline = 'alphabetic';
  gctx.fillStyle = '#131319'; gctx.shadowColor = 'rgba(19,19,25,0.55)'; gctx.shadowBlur = .9 + Math.max(0, (op.h ?? 0) - .8) * 3;   // a hot head spreads a little
  gctx.fillText(op.ch, 0, 0);
  gctx.restore();
  // ribbon texture: pinholes where the film didn't transfer
  gctx.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 26; k++) { gctx.globalAlpha = .12 + r() * .38; gctx.beginPath(); gctx.arc(r() * 48, 8 + r() * 44, .35 + r() * .8, 0, TAU); gctx.fill(); }
  // hammer never lands perfectly square: one edge prints lighter
  const edge = r(), gr = gctx.createLinearGradient(edge < .5 ? 0 : 48, 0, edge < .5 ? 48 : 0, r() * 20);
  gr.addColorStop(0, `rgba(0,0,0,${.12 + r() * .25})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
  gctx.globalAlpha = 1; gctx.fillStyle = gr; gctx.fillRect(0, 0, 48, 56);
  // a cold head leaves more voids: extra pinholes, from their own sequence so positions above stay put
  const cold = heatCold(op);
  if (cold > 0) {
    const cr = rng(op.seed ^ 0x51ED27);
    gctx.globalCompositeOperation = 'destination-out';
    for (let k = 0, n = Math.round(cold * 34); k < n; k++) { gctx.globalAlpha = .25 + cr() * .45; gctx.beginPath(); gctx.arc(cr() * 48, 8 + cr() * 44, .3 + cr() * .8, 0, TAU); gctx.fill(); }
    gctx.globalAlpha = 1;
  }
  gctx.globalCompositeOperation = 'source-over';
  const cx = (m + (op.col + .5) * PITCH) * DPI + (r() - .5) * .7 + (op.ov || 0) * .9 - ox;   // overstrikes land a hair to the right: bold
  const by = op.v * DPI + BASE_OFF + (r() - .5) * .9 - oy;
  const a = Math.min(1, (.72 + op.w * .24) * (.93 + r() * .07) * heatDensity(op));
  if (op.erased) { liftOff(ctx, op, cx, by); return; }
  ctx.globalAlpha = a;
  ctx.drawImage(glyphCanvas, cx - 24, by - 38);
  ctx.globalAlpha = 1;
}
// Lift-off correction. The film re-melts the character and pulls most of it away. What stays is what
// real correction left: a faint haze of the letter, a few fragments along the stroke edges where the
// film didn't take hold, and a slightly scuffed patch of paper. All of it seeded, so it never changes.
function liftOff(ctx, op, cx, by) {
  const lr = rng(op.seed ^ 0x2545F491);
  lctx.globalCompositeOperation = 'source-over'; lctx.globalAlpha = 1; lctx.clearRect(0, 0, 48, 56);
  lctx.fillStyle = '#000'; lctx.globalAlpha = .06; lctx.fillRect(0, 0, 48, 56);            // the haze
  for (let i = 0; i < 20; i++) {                                                            // the fragments
    lctx.globalAlpha = .1 + lr() * .32; lctx.beginPath();
    lctx.ellipse(lr() * 48, 6 + lr() * 46, .5 + lr() * 2.2, .3 + lr() * 1.1, lr() * Math.PI, 0, TAU); lctx.fill();
  }
  gctx.globalCompositeOperation = 'destination-in'; gctx.globalAlpha = 1; gctx.drawImage(liftCanvas, 0, 0);
  gctx.globalCompositeOperation = 'source-over';
  const sx = (lr() - .5) * 1.2, sy = -lr() * .8;                                            // the film tugs it a hair as it lets go
  ctx.globalAlpha = 1; ctx.drawImage(glyphCanvas, cx - 24 + sx, by - 38 + sy);
  // the scuff: fibres roughened by the film catch a little grey
  ctx.save();
  const ex = cx + (lr() - .5) * 2, ey = by - 9 + (lr() - .5) * 2, rx = 11 + lr() * 4, ry = 15 + lr() * 3;
  const g = ctx.createRadialGradient(ex, ey, 1, ex, ey, ry);
  g.addColorStop(0, 'rgba(70,62,50,.05)'); g.addColorStop(.7, 'rgba(70,62,50,.025)'); g.addColorStop(1, 'rgba(70,62,50,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(ex, ey, rx, ry, (lr() - .5) * .4, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(70,62,50,.07)'; ctx.lineWidth = .45; ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const x = ex + (lr() - .5) * rx * 1.4, y = ey + (lr() - .5) * ry * 1.4, a = lr() * Math.PI, l = 2 + lr() * 4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + Math.cos(a) * l * .5 + (lr() - .5) * 2, y + Math.sin(a) * l * .5, x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  ctx.restore();
}
const opRect = (op, m = 1) => ({ x: (m + (op.col + .5) * PITCH) * DPI - 26, y: op.v * DPI + BASE_OFF - 40, w: 52, h: 60 });

// torn edge profile (inches, across the paper width)
const JAG_N = 700;
const tearSeed = perforated => perforated ? (randSeed() | 0x80000000) >>> 0 : randSeed() & 0x7fffffff;
function jagProfile(seed) {
  const r = rng(seed), a = new Float32Array(JAG_N);
  if (seed & 0x80000000) {   // fanfold tears along its perforation: nearly straight, tiny teeth
    for (let i = 0; i < JAG_N; i++) a[i] = ((i % 7) < 4 ? .005 : -.003) + (r() - .5) * .003;
    return a;
  }
  let y = 0, v = 0; const tilt = (r() - .5) * .03, ph = r() * TAU;
  for (let i = 0; i < JAG_N; i++) {
    v += (r() - .5) * .011; v *= .6; y += v; y *= .93;
    a[i] = clamp(y + (r() - .5) * .005 + tilt * (i / JAG_N - .5) + .006 * Math.sin(i * .011 + ph) + .004 * Math.sin(i * .037 + ph * 3), -JAG_A * .9, JAG_A * .9);
  }
  return a;
}
const jagCache = new Map();
const jagAt = (seed, xIn, w) => { let p = jagCache.get(seed); if (!p) { p = jagProfile(seed); jagCache.set(seed, p); } return p[clamp(Math.floor(xIn / w * JAG_N), 0, JAG_N - 1)]; };

// fanfold computer paper: tractor strips with sprocket holes, faint green bars, page perforations
const FAN_STRIP = .5, FAN_HOLE_R = .075, FAN_PAGE = 11;
function drawAlpha(c, lenIn, topSeed, botSeed, P) {
  const g = c.getContext('2d'), sx = c.width / P.w, sy = c.height / lenIn;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
  for (let px = 0; px < c.width; px++) {
    const xIn = (px + .5) / sx;
    if (topSeed != null) g.fillRect(px, 0, 1, (JAG_A + jagAt(topSeed, xIn, P.w)) * sy);
    if (botSeed != null) { const y = (lenIn - JAG_A + jagAt(botSeed, xIn, P.w)) * sy; g.fillRect(px, y, 1, c.height - y); }
  }
  if (P.type === 'card') {
    // a die-cut card: nothing past its length, and softly rounded corners
    const ey = Math.min(lenIn, CARD_LEN) * sy, rx = .09 * sx, ry = .09 * sy;
    g.fillRect(0, ey, c.width, c.height - ey);
    for (const [cx, cy] of [[rx, ry], [c.width - rx, ry], [rx, ey - ry], [c.width - rx, ey - ry]]) {
      g.fillStyle = '#000'; g.fillRect(cx < c.width / 2 ? 0 : cx, cy < ey / 2 ? 0 : cy, rx, ry);
      g.fillStyle = '#fff'; g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); g.fill();
    }
    g.fillStyle = '#000';
  }
  if (P.type === 'fan') {
    for (let k = Math.floor(P.v0 / .5) - 1; (k * .5 + .25 - P.v0) < lenIn + .5; k++) {
      const cy = (k * .5 + .25 - P.v0) * sy;
      for (const hx of [.25, P.w - .25]) { g.beginPath(); g.arc(hx * sx, cy, FAN_HOLE_R * sx, 0, TAU); g.fill(); }
    }
  }
}
function drawFringe(g, seed, centerIn, below, P, x0 = 0, x1 = Infinity) {
  const cw = Math.round(P.w * DPI);
  g.fillStyle = 'rgba(255,253,247,0.7)';
  for (let px = Math.max(0, x0) & ~1; px < Math.min(cw, x1); px += 2) {
    const y = (centerIn + jagAt(seed, (px + 1) / DPI, P.w)) * DPI;
    g.fillRect(px, below ? y : y - 2.2, 2, 2.2);
  }
}
function paintBase(c, x, y, w, h, P) {
  c.fillStyle = paperPattern(c); c.fillRect(x, y, w, h);
  if (P.type === 'card') {
    // bristol stock: slightly warmer, a red header rule and pale blue lines
    c.fillStyle = 'rgba(255,248,232,0.35)'; c.fillRect(x, y, w, h);
    const rule = (v, col, th) => { const py = v * DPI; if (py + th >= y && py - th <= y + h) { c.fillStyle = col; c.fillRect(Math.max(x, 0), py - th / 2, w, th); } };
    const rules = P.rules || cardRules(CARD_TOP, LINE_H);
    rules.forEach((v, i) => rule(v, i ? 'rgba(96,140,200,0.34)' : 'rgba(206,74,74,0.6)', i ? 1.4 : 2.2));
    return;
  }
  if (P.type !== 'fan') return;
  const fx0 = FAN_STRIP * DPI, fx1 = (P.w - FAN_STRIP) * DPI;
  // green bars: half-inch bands every inch, phased to the roll so they continue across tears
  c.fillStyle = 'rgba(92,150,104,0.2)';
  const a0 = y / DPI + P.v0, a1 = (y + h) / DPI + P.v0;
  for (let j = Math.floor(a0) - 1; j <= a1; j++) {
    const top = (j - P.v0) * DPI, bot = top + .5 * DPI;
    const t = Math.max(top, y), bb = Math.min(bot, y + h), l = Math.max(fx0, x), r = Math.min(fx1, x + w);
    if (bb > t && r > l) c.fillRect(l, t, r - l, bb - t);
  }
  // micro-perforations beside the tractor strips
  c.fillStyle = 'rgba(110,100,86,0.4)';
  for (let py = y - (y % 5); py < y + h; py += 5) { for (const px of [fx0, fx1]) if (px >= x - 2 && px <= x + w + 2) c.fillRect(px - .6, py, 1.2, 2.5); }
  // page perforation every 11 inches
  for (let k = Math.ceil(a0 / FAN_PAGE); k * FAN_PAGE <= a1; k++) {
    const py = (k * FAN_PAGE - P.v0) * DPI;
    for (let px = Math.max(0, x) - (Math.max(0, x) % 6); px < x + w; px += 6) c.fillRect(px, py - .6, 3, 1.2);
  }
  // faint tractor strip tint
  c.fillStyle = 'rgba(140,125,100,0.05)';
  for (const [l0, r0] of [[0, fx0], [fx1, P.w * DPI]]) { const l = Math.max(l0, x), r = Math.min(r0, x + w); if (r > l) c.fillRect(l, y, r - l, h); }
}

// ---------------------------------------------------------------- sheet on the platen
class Sheet {
  constructor({ ops = [], feed = 1.5, topJag = null, P = DEFAULT_SPEC, seed = randSeed() } = {}) {
    this.ops = ops; this.feed = feed; this.topJag = topJag; this.P = { ...P }; this.cw = Math.round(P.w * DPI); this.seed = seed;
    this.canvas = mkCanvas(this.cw, CH); this.ctx = this.canvas.getContext('2d');
    this.ink = mkCanvas(this.cw, CH); this.ictx = this.ink.getContext('2d');
    this.alpha = mkCanvas(this.cw / 2, CH / 2); drawAlpha(this.alpha, ROLL_LEN, topJag, null, this.P);
    for (const op of ops) drawOp(this.ictx, op, 0, 0, this.P.m);
    this.compositeRect(0, 0, this.cw, CH);
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = MAX_ANISO;
    this.atex = new THREE.CanvasTexture(this.alpha);
    this.dirty = false;
  }
  compositeRect(x, y, w, h) {
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y)); w = Math.min(this.cw - x, Math.ceil(w) + 1); h = Math.min(CH - y, Math.ceil(h) + 1);
    if (w <= 0 || h <= 0) return;
    const c = this.ctx; c.save();
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    c.globalCompositeOperation = 'source-over'; paintBase(c, x, y, w, h, this.P);
    c.globalCompositeOperation = 'multiply'; c.drawImage(this.ink, x, y, w, h, x, y, w, h);
    c.globalCompositeOperation = 'source-over';
    if (this.topJag != null && y < JAG_A * 3 * DPI) drawFringe(c, this.topJag, JAG_A, true, this.P, x, x + w);
    c.restore(); this.dirty = true;
    const d = this.dr; this.dr = d ? { x0: Math.min(d.x0, x), y0: Math.min(d.y0, y), x1: Math.max(d.x1, x + w), y1: Math.max(d.y1, y + h) } : { x0: x, y0: y, x1: x + w, y1: y + h };
  }
  strike(ch, col, w) {
    const op = this.newOp(ch, col, w);
    this.ops.push(op); drawOp(this.ictx, op, 0, 0, this.P.m); const r = opRect(op, this.P.m); this.compositeRect(r.x, r.y, r.w, r.h); return op;
  }
  newOp(ch, col, w) {
    const v = this.feed;
    let ov = 0; for (const o of this.ops) if (!o.erased && o.col === col && o.ch === ch && Math.abs(o.v - v) < .01) ov++;
    return { ch, col, v, seed: mixSeed(this.seed, this.ops.length), w, erased: false, ov };
  }
  // thermal head: characters are queued, then burned in strip by strip as the head passes
  addPending(ch, col, w) {
    const op = this.newOp(ch, col, w); op.rev = -1e9;
    this.ops.push(op); (this.pending ||= []).push(op); return op;
  }
  revealTo(xWorld) {
    if (!this.pending || !this.pending.length) return;
    const px = (xWorld + this.P.w / 2) * DPI;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const op = this.pending[i], r = opRect(op, this.P.m), from = Math.max(r.x, op.rev), to = Math.min(r.x + r.w, px);
      if (to > from) {
        if (op.rev === -1e9 && op.h == null) burnHeat(op);
        const g = this.ictx; g.save(); g.beginPath(); g.rect(from, r.y, to - from, r.h); g.clip(); drawOp(g, op, 0, 0, this.P.m); g.restore();
        this.compositeRect(from, r.y, to - from, r.h); op.rev = to;
      }
      if (op.rev >= r.x + r.w - .01) this.pending.splice(i, 1);
    }
  }
  // redraw every character from the ops (used when the typeface arrives after the page was drawn)
  repaint() {
    this.ictx.clearRect(0, 0, this.cw, CH);
    const pend = new Set(this.pending || []);
    for (const op of this.ops) { if (pend.has(op)) op.rev = -1e9; else drawOp(this.ictx, op, 0, 0, this.P.m); }
    this.compositeRect(0, 0, this.cw, CH);
  }
  // lift-off follows the head across the cell, like printing does
  liftTo(targets, xWorld) {
    const px = (xWorld + this.P.w / 2) * DPI, r = opRect(targets[0], this.P.m);
    const from = Math.max(r.x, targets.liftX ?? r.x), to = Math.min(r.x + r.w, px);
    if (to <= from) return;
    targets.liftX = to;
    const g = this.ictx, t = targets[0];
    g.save(); g.beginPath(); g.rect(from, r.y, to - from, r.h); g.clip(); g.clearRect(from, r.y, to - from, r.h);
    for (const o of this.ops) if (Math.abs(o.v - t.v) < .5 && Math.abs(o.col - t.col) <= 1 && !(this.pending || []).includes(o)) drawOp(g, o, 0, 0, this.P.m);
    g.restore(); this.compositeRect(from, r.y, to - from, r.h);
  }
  // everything printed in this column on the current line: the letter, its bold strike, its underline
  findOps(col) { return this.ops.filter(o => o.col === col && Math.abs(o.v - this.feed) < .02 && !o.erased); }
  findOp(col) { for (let i = this.ops.length - 1; i >= 0; i--) { const o = this.ops[i]; if (o.col === col && Math.abs(o.v - this.feed) < .02 && !o.erased) return o; } return null; }
  redrawAround(op) {
    const r = opRect(op, this.P.m), g = this.ictx;
    g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip(); g.clearRect(r.x, r.y, r.w, r.h);
    for (const o of this.ops) if (Math.abs(o.v - op.v) < .5 && Math.abs(o.col - op.col) <= 1) drawOp(g, o, 0, 0, this.P.m);
    g.restore(); this.compositeRect(r.x, r.y, r.w, r.h);
  }
  lastInkV() { let m = -1; for (const o of this.ops) if (o.v > m) m = o.v; return m; }
  dispose() { this.tex.dispose(); this.atex.dispose(); for (const c of [this.canvas, this.ink, this.alpha]) c.width = c.height = 1; }
}

const PAPER_SEGS = 900, PNX = 6;
const paperGeo = new THREE.BufferGeometry();
{
  const n = (PAPER_SEGS + 1) * (PNX + 1);
  paperGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  paperGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const idx = [];
  for (let j = 0; j < PAPER_SEGS; j++) for (let i = 0; i < PNX; i++) {
    const a = j * (PNX + 1) + i, b = a + 1, c = a + PNX + 1, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  paperGeo.setIndex(idx);
}
const paperMat = new THREE.MeshStandardMaterial({ roughness: .9, metalness: 0, side: THREE.DoubleSide, alphaTest: .5 });
const paperMesh = new THREE.Mesh(paperGeo, paperMat);
paperMesh.castShadow = paperMesh.receiveShadow = true; paperMesh.frustumCulled = false; machine.add(paperMesh);
let sheet = null;
function setSheet(s) {
  const old = sheet; sheet = s; lastFeedDrawn = NaN; paperMat.map = s.tex; paperMat.alphaMap = s.atex; paperMat.needsUpdate = true;
  if (old) old.dispose();
}
let lastFeedDrawn = NaN;
function updatePaperMesh() {
  if (sheet.feed === lastFeedDrawn) return false; lastFeedDrawn = sheet.feed;
  const pos = paperGeo.attributes.position.array, uv = paperGeo.attributes.uv.array;
  const vmax = sheet.feed + TAIL;
  for (let j = 0; j <= PAPER_SEGS; j++) {
    const mv = j / PAPER_SEGS * vmax; sample(sheet.feed - mv); const vv = 1 - mv / ROLL_LEN;
    for (let i = 0; i <= PNX; i++) {
      const k = j * (PNX + 1) + i;
      pos[k * 3] = -sheet.P.w / 2 + i / PNX * sheet.P.w; pos[k * 3 + 1] = PT.y; pos[k * 3 + 2] = PT.z;
      uv[k * 2] = i / PNX; uv[k * 2 + 1] = vv;
    }
  }
  paperGeo.attributes.position.needsUpdate = true; paperGeo.attributes.uv.needsUpdate = true;
  paperGeo.computeVertexNormals();
  return true;
}

// ---------------------------------------------------------------- scraps on the desk
const scraps = [];
const DESK_SPOTS = [[-4.6, 6.4], [-6.6, 7.0], [-3.2, 7.6], [-7.8, 6.2], [-5.2, 8.2], [-9.2, 7.4]];
// The desk keeps a heightfield of everything lying on it, so each scrap drapes over the ones
// beneath instead of passing through them. Paper has a little stiffness: it bridges small steps
// with a gentle slope rather than folding into them.
// The desk is unbounded: its heightfield lives in 6.4" chunks, created only where paper lies.
const HF_C = .1, hfChunks = new Map();
const hfKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
const hfReset = () => hfChunks.clear();
const hfGet = (ix, iz) => { const ch = hfChunks.get(hfKey(ix >> 6, iz >> 6)); return ch ? ch[((iz & 63) << 6) | (ix & 63)] : DESK_Y; };
function hfMax(ix, iz, y) {
  const k = hfKey(ix >> 6, iz >> 6); let ch = hfChunks.get(k);
  if (!ch) { ch = new Float32Array(4096).fill(DESK_Y); hfChunks.set(k, ch); }
  const i = ((iz & 63) << 6) | (ix & 63); if (y > ch[i]) ch[i] = y;
}
function hfTop() { let t = DESK_Y; for (const ch of hfChunks.values()) for (let i = 0; i < 4096; i++) if (ch[i] > t) t = ch[i]; return t; }
const DRAPE_R = 2, DRAPE_K = 1.4;          // flat for ~0.14" past an edge beneath (half the mesh spacing), then falls
function drapeAt(x, z) {
  const fx = x / HF_C, fz = z / HF_C, cx = Math.round(fx), cz = Math.round(fz);
  let best = DESK_Y;
  for (let dz = -DRAPE_R; dz <= DRAPE_R; dz++) for (let dx = -DRAPE_R; dx <= DRAPE_R; dx++) {
    const h = hfGet(cx + dx, cz + dz); if (h <= best) continue;
    const v = h - DRAPE_K * Math.max(0, Math.hypot(cx + dx - fx, cz + dz - fz) * HF_C - .14);
    if (v > best) best = v;
  }
  return best;
}
function hfRaster(sc, v) {
  const NX = sc.NX, SUB = 3;
  for (let j = 0; j < sc.NS; j++) for (let i = 0; i < NX; i++) {
    const a = (j * (NX + 1) + i) * 3, b = a + 3, c = a + (NX + 1) * 3, d = c + 3;
    for (let q = 0; q <= SUB; q++) for (let p = 0; p <= SUB; p++) {
      const u = p / SUB, w = q / SUB, k0 = (1 - u) * (1 - w), k1 = u * (1 - w), k2 = (1 - u) * w, k3 = u * w;
      const x = v[a] * k0 + v[b] * k1 + v[c] * k2 + v[d] * k3, y = v[a + 1] * k0 + v[b + 1] * k1 + v[c + 1] * k2 + v[d + 1] * k3, z = v[a + 2] * k0 + v[b + 2] * k1 + v[c + 2] * k2 + v[d + 2] * k3;
      hfMax(Math.round(x / HF_C), Math.round(z / HF_C), y);
    }
  }
}
// Shadows of sheets on the desk. Thin paper on paper is below what the lamp's shadow map can resolve,
// so each sheet carries its own shadow: a blurred copy of its real silhouette (torn edges, sprocket
// holes and all) laid on whatever is beneath it. Two falloffs are mixed: a tight dark contact line
// where the edge meets the surface, and a soft occlusion a little further out. It is pushed away from
// the lamp in proportion to how high the sheet is, and grows softer and fainter as the sheet lifts.
const SH_M = .35, SH_PPI = 28;
function boxBlur(a, w, h, r) {
  if (r < 1) return a;
  const t = new Float32Array(a.length), o = new Float32Array(a.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) { let acc = 0; const row = y * w; for (let x = -r; x <= r; x++) acc += a[row + clamp(x, 0, w - 1)]; for (let x = 0; x < w; x++) { t[row + x] = acc / n; acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; } }
  for (let x = 0; x < w; x++) { let acc = 0; for (let y = -r; y <= r; y++) acc += t[clamp(y, 0, h - 1) * w + x]; for (let y = 0; y < h; y++) { o[y * w + x] = acc / n; acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; } }
  return o;
}
function shadowTexture(P, len, topJag, botJag, folded = 0) {
  const L = folded ? len / 2 : len;
  const w = Math.ceil((P.w + 2 * SH_M) * SH_PPI), h = Math.ceil((L + 2 * SH_M) * SH_PPI);
  const sil = mkCanvas(Math.round(P.w * SH_PPI), Math.round(len * SH_PPI)); drawAlpha(sil, len, topJag, botJag, P);
  const c = mkCanvas(w, h), g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.drawImage(sil, 0, 0, sil.width, L * SH_PPI, SH_M * SH_PPI, SH_M * SH_PPI, sil.width, L * SH_PPI);
  if (folded) {   // the far half, flipped over the crease, adds its outline on top
    g.save(); g.globalCompositeOperation = 'lighten'; g.translate(0, (SH_M + L) * SH_PPI); g.scale(1, -1);
    g.drawImage(sil, 0, L * SH_PPI, sil.width, L * SH_PPI, SH_M * SH_PPI, 0, sil.width, L * SH_PPI); g.restore();
  }
  const id = g.getImageData(0, 0, w, h), d = id.data, a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4] / 255;
  const tight = boxBlur(boxBlur(a, w, h, 1), w, h, 1), soft = boxBlur(boxBlur(a, w, h, 3), w, h, 3);
  for (let i = 0; i < a.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0; d[i * 4 + 3] = Math.min(255, (tight[i] * .5 + soft[i] * .22) * (1 - a[i]) * 255); }   // nothing under the sheet itself: only its edges, notches and holes
  g.putImageData(id, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// Paper rendering at any resolution. On the desk a sheet only needs ~60 dpi and a plain glyph (the
// ribbon speckle is invisible at that size), which is ~10× cheaper to draw and ~6× lighter on the GPU.
// The full 150 dpi render with every speckle is made only when a sheet is picked up to read.
const DESK_DPI = 60;
function fastGlyph(g, op, m) {
  const r = rng(op.seed);
  for (let i = 0; i < 108; i++) r();                                 // stay in step with drawOp's jitter
  const cx = (m + (op.col + .5) * PITCH) * DPI + (r() - .5) * .7 + (op.ov || 0) * .9;
  const by = op.v * DPI + BASE_OFF + (r() - .5) * .9;
  g.globalAlpha = op.erased ? .05 : Math.min(1, (.72 + op.w * .24) * (.93 + r() * .07) * heatDensity(op));
  g.fillText(op.ch, cx, by);
}
function renderPaper(P, len, ops, topJag, botJag, dpi, full) {
  const k = dpi / DPI, cw = Math.max(1, Math.round(P.w * dpi)), H = Math.max(1, Math.ceil(len * dpi));
  const map = mkCanvas(cw, H), g = map.getContext('2d');
  g.save(); g.scale(k, k); paintBase(g, 0, 0, P.w * DPI, len * DPI, P); g.restore();
  if (ops && ops.length) {
    const ink = mkCanvas(cw, H), ig = ink.getContext('2d'); ig.scale(k, k);
    if (full) for (const o of ops) drawOp(ig, o, 0, 0, P.m);
    else {
      ig.font = `${FONT_PX}px "Courier Prime", "Courier New", monospace`; ig.textAlign = 'center'; ig.textBaseline = 'alphabetic'; ig.fillStyle = '#131319';
      for (const o of ops) fastGlyph(ig, o, P.m);
      ig.globalAlpha = 1;
    }
    g.globalCompositeOperation = 'multiply'; g.drawImage(ink, 0, 0); g.globalCompositeOperation = 'source-over';
    ink.width = ink.height = 1;
  }
  g.save(); g.scale(k, k);
  if (topJag != null) drawFringe(g, topJag, JAG_A, true, P);
  if (botJag != null) drawFringe(g, botJag, len - JAG_A, false, P);
  g.restore();
  const alpha = mkCanvas(cw, H); drawAlpha(alpha, len, topJag, botJag, P);
  return { map, alpha };
}
const canvasTex = (c, srgb = true) => { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO; return t; };
// the back of a sheet shows only a faint ghost of what's printed on the front
function paperBackFace(mat) {
  mat.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
      '#include <map_fragment>\n if (!gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.9, .88, .83), .82);');
  };
}
// jobs that fill in desk textures a few at a time, nearest to the view first
const texQueue = [];
function pumpTextures(budget) {
  if (!texQueue.length) return false;
  if (texQueue.length > 1) texQueue.sort((a, b) => b.viewDist() - a.viewDist());
  const t0 = performance.now();
  while (texQueue.length && performance.now() - t0 < budget) texQueue.pop().prepare();
  return true;
}

// ---- the desk marker: one size, one colour. Strokes are stored as vectors in paper inches, so they
// render crisply at any resolution (desk texture, held-up sheet, PNG export). A vermilion felt tip,
// multiplied over the paper so the type shows through.
const MARK_W = .05, MARK_COL = 'rgb(212,88,58)';
function markPath(g, pts, k) {
  const n = pts.length / 2;
  if (n === 1) { g.beginPath(); g.arc(pts[0] * k, pts[1] * k, MARK_W * k / 2, 0, TAU); g.fill(); return; }
  g.beginPath(); g.moveTo(pts[0] * k, pts[1] * k);
  for (let i = 1; i < n - 1; i++) {               // smooth: quadratic through the midpoints
    const x = pts[i * 2] * k, y = pts[i * 2 + 1] * k, nx = pts[i * 2 + 2] * k, ny = pts[i * 2 + 3] * k;
    g.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  g.lineTo(pts[n * 2 - 2] * k, pts[n * 2 - 1] * k); g.stroke();
}
function drawMarks(g, k, strokes) {
  g.save(); g.fillStyle = g.strokeStyle = MARK_COL; g.lineWidth = MARK_W * k; g.lineCap = g.lineJoin = 'round';
  for (const p of strokes) markPath(g, p, k);
  g.restore();
}

class Scrap {
  constructor({ id, len, ops, topJag, botJag, desk, P = DEFAULT_SPEC, seed = randSeed(), created = Date.now(), folded = 0, lowMap = null, marks = [] }) {
    Object.assign(this, { len, ops, topJag, botJag, desk, P: { ...P }, seed, created, folded, marks });
    this.id = id || 's' + randSeed().toString(36);
    this.foldA = folded ? Math.PI : 0;
    const PW = this.P.w;
    this.NX = 34; this.NS = Math.max(10, Math.ceil(len * 4));
    const n = (this.NX + 1) * (this.NS + 1);
    const geo = new THREE.BufferGeometry();
    const uv = new Float32Array(n * 2); this.xa = new Float32Array(n); this.sa = new Float32Array(n);
    for (let j = 0; j <= this.NS; j++) for (let i = 0; i <= this.NX; i++) {
      const k = j * (this.NX + 1) + i; uv[k * 2] = i / this.NX; uv[k * 2 + 1] = 1 - j / this.NS;
      this.xa[k] = -PW / 2 + i / this.NX * PW; this.sa[k] = j / this.NS * len;
    }
    const idx = [];
    for (let j = 0; j < this.NS; j++) for (let i = 0; i < this.NX; i++) { const a = j * (this.NX + 1) + i, b = a + 1, c = a + this.NX + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(idx);
    this.pos = geo.attributes.position.array; this.count = n;
    // desk texture: given (a fresh tear) or blank paper now, inked in later by the texture queue
    const base = lowMap ? { map: lowMap, alpha: null } : renderPaper(this.P, len, null, topJag, botJag, DESK_DPI, false);
    if (!base.alpha) { base.alpha = mkCanvas(lowMap.width, lowMap.height); drawAlpha(base.alpha, len, topJag, botJag, this.P); }
    this.lowMap = base.map; this.lowTex = canvasTex(base.map); this.lowAlpha = canvasTex(base.alpha, false);
    this.inked = !!lowMap;
    this.mat = new THREE.MeshStandardMaterial({ map: this.lowTex, alphaMap: this.lowAlpha, alphaTest: .5, side: THREE.DoubleSide, roughness: .92, emissive: 0xffffff, emissiveIntensity: 0, fog: false });
    paperBackFace(this.mat);
    this.mesh = new THREE.Mesh(geo, this.mat); this.mesh.castShadow = this.mesh.receiveShadow = true; this.mesh.frustumCulled = false;
    this.mesh.userData.scrap = this; scene.add(this.mesh);
    this.state = 'desk'; this.flight = null; this.pan = 0; this.panS = 0;
    this.shadowMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false });
    this.shadow = new THREE.Mesh(new THREE.BufferGeometry(), this.shadowMat); this.shadow.frustumCulled = false; this.shadow.visible = false; this.shadow.renderOrder = 1;
    scene.add(this.shadow);
    this.buildShadowGrid();
    this.ageTint();
    if (!this.inked || !this.shadowMat.map) texQueue.push(this);
  }
  effLen() { return this.folded ? this.len / 2 : this.len; }
  viewDist() { const [x, z] = this.toWorld(0, this.len / 2); return Math.hypot(x - camTgt.x, z - camTgt.z); }
  // idle-time work: ink the desk texture, build the shadow
  prepare() {
    if (this.disposed) return;
    if (!this.inked) {
      const { map } = renderPaper(this.P, this.len, this.ops, this.topJag, this.botJag, DESK_DPI, false);
      this.lowMap.getContext('2d').drawImage(map, 0, 0); map.width = map.height = 1;
      this.lowTex.needsUpdate = true; this.inked = true;
      if (this.marks.length) { this.lowBase = null; this.ensureMarkLayers(); this.redrawMarksLow(); }
    }
    if (!this.shadowMat.map) {
      this.shadowMat.map = shadowTexture(this.P, this.len, this.topJag, this.botJag, this.folded); this.shadowMat.needsUpdate = true;
      this.shadow.visible = this.state === 'desk';
    }
  }
  // the grid the shadow lies on, sized to the sheet as it currently lies (folded or not)
  buildShadowGrid() {
    const PW = this.P.w, L = this.effLen();
    this.SX = 26; this.SS = Math.max(8, Math.ceil(L * 3));
    const sn = (this.SX + 1) * (this.SS + 1), sg = new THREE.BufferGeometry(), suv = new Float32Array(sn * 2);
    this.sl = new Float32Array(sn * 2);
    for (let j = 0; j <= this.SS; j++) for (let i = 0; i <= this.SX; i++) {
      const k = j * (this.SX + 1) + i;
      this.sl[k * 2] = -PW / 2 - SH_M + i / this.SX * (PW + 2 * SH_M); this.sl[k * 2 + 1] = -SH_M + j / this.SS * (L + 2 * SH_M);
      suv[k * 2] = i / this.SX; suv[k * 2 + 1] = 1 - j / this.SS;
    }
    const sidx = [];
    for (let j = 0; j < this.SS; j++) for (let i = 0; i < this.SX; i++) { const a = j * (this.SX + 1) + i, b = a + 1, c = a + this.SX + 1, d = c + 1; sidx.push(a, c, b, b, c, d); }
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sn * 3), 3));
    sg.setAttribute('uv', new THREE.BufferAttribute(suv, 2)); sg.setIndex(sidx);
    this.shadow.geometry.dispose(); this.shadow.geometry = sg;
  }
  // full-resolution texture while the sheet is held up to read (or exported)
  // Marker layers. Each texture the sheet shows (the 60 dpi desk one, and the 150 dpi one while it's
  // held) keeps its clean paper, a marks canvas, and the composite that's displayed.
  layers() { const L = [{ map: this.lowMap, tex: this.lowTex, dpi: DESK_DPI, k: 'low' }]; if (this.fullMap) L.push({ map: this.fullMap, tex: this.fullTex, dpi: DPI, k: 'full' }); return L; }
  ensureMarkLayers() {
    if (!this.inked) this.prepare();
    for (const L of this.layers()) {
      if (this[L.k + 'Base']) continue;
      const base = mkCanvas(L.map.width, L.map.height); base.getContext('2d').drawImage(L.map, 0, 0);
      this[L.k + 'Base'] = base; this[L.k + 'Marks'] = mkCanvas(L.map.width, L.map.height);
    }
  }
  compositeLayer(L, r) {
    const base = this[L.k + 'Base'], marks = this[L.k + 'Marks']; if (!base) return;
    const W = L.map.width, H = L.map.height, g = L.map.getContext('2d');
    const x = r ? Math.max(0, Math.floor(r.x0)) : 0, y = r ? Math.max(0, Math.floor(r.y0)) : 0;
    const w = (r ? Math.min(W, Math.ceil(r.x1)) : W) - x, h = (r ? Math.min(H, Math.ceil(r.y1)) : H) - y;
    if (w <= 0 || h <= 0) return;
    g.drawImage(base, x, y, w, h, x, y, w, h);
    g.globalCompositeOperation = 'multiply'; g.drawImage(marks, x, y, w, h, x, y, w, h); g.globalCompositeOperation = 'source-over';
    uploadRegion(L.tex, g, { x0: x, y0: y, x1: x + w, y1: y + h });
    invalidate();
  }
  redrawMarksLow() {
    this.ensureMarkLayers();
    for (const L of this.layers()) {
      const m = this[L.k + 'Marks'], g = m.getContext('2d'); g.clearRect(0, 0, m.width, m.height);
      drawMarks(g, L.dpi, this.marks); this.compositeLayer(L, null);
    }
  }
  // live stroke: redraw it (opaque, so re-drawing is exact) and refresh only around the newest points
  drawLiveStroke(pts) {
    this.ensureMarkLayers();
    const n = pts.length / 2;
    for (const L of this.layers()) {
      drawMarks(this[L.k + 'Marks'].getContext('2d'), L.dpi, [pts]);
      const k = L.dpi, pad = MARK_W * k + 3; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = Math.max(0, n - 4); i < n; i++) { x0 = Math.min(x0, pts[i * 2] * k); x1 = Math.max(x1, pts[i * 2] * k); y0 = Math.min(y0, pts[i * 2 + 1] * k); y1 = Math.max(y1, pts[i * 2 + 1] * k); }
      this.compositeLayer(L, { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad });
    }
  }
  ensureFull() {
    if (this.fullMap) return;
    const { map, alpha } = renderPaper(this.P, this.len, this.ops, this.topJag, this.botJag, DPI, true);
    const fullBase = mkCanvas(map.width, map.height); fullBase.getContext('2d').drawImage(map, 0, 0);
    const fullMarks = mkCanvas(map.width, map.height); drawMarks(fullMarks.getContext('2d'), DPI, this.marks);
    { const g = map.getContext('2d'); g.globalCompositeOperation = 'multiply'; g.drawImage(fullMarks, 0, 0); g.globalCompositeOperation = 'source-over'; }
    this.fullBase = fullBase; this.fullMarks = fullMarks;
    this.fullMap = map; this.fullAlphaC = alpha;
    this.fullTex = canvasTex(map); this.fullAlpha = canvasTex(alpha, false);
    this.mat.map = this.fullTex; this.mat.alphaMap = this.fullAlpha; this.mat.needsUpdate = true;
  }
  releaseFull() {
    if (!this.fullMap) return;
    this.mat.map = this.lowTex; this.mat.alphaMap = this.lowAlpha; this.mat.needsUpdate = true;
    this.fullTex.dispose(); this.fullAlpha.dispose(); this.fullMap.width = this.fullMap.height = 1; this.fullAlphaC.width = this.fullAlphaC.height = 1;
    for (const c of [this.fullBase, this.fullMarks]) if (c) c.width = c.height = 1;
    this.fullMap = this.fullAlphaC = this.fullTex = this.fullAlpha = this.fullBase = this.fullMarks = null;
  }
  // paper warms and yellows a little with age (days, not minutes)
  ageTint() {
    const days = Math.max(0, (Date.now() - this.created) / 864e5), a = 1 - Math.exp(-days / 12);
    this.mat.color.setRGB(1, 1 - .035 * a, 1 - .11 * a);
  }
  toWorld(lx, ls) { const { x, z, yaw } = this.desk, cy = Math.cos(yaw), sy = Math.sin(yaw); return [x + lx * cy + ls * sy, z - lx * sy + ls * cy]; }
  // lift: how far the sheet is above the surface beneath it (0 when lying down)
  updateShadow(lift = 0) {
    const p = this.shadow.geometry.attributes.position.array, L = this.effLen();
    const [cx, cz] = this.toWorld(0, L / 2), dy = lamp.position.y - DESK_Y;
    const e = .012 + lift, ox = (cx - lamp.position.x) / dy * e, oz = (cz - lamp.position.z) / dy * e;   // cast away from the lamp
    const grow = 1 + lift * .08;
    for (let k = 0; k < this.sl.length / 2; k++) {
      const [wx, wz] = this.toWorld(this.sl[k * 2] * grow, (this.sl[k * 2 + 1] - L / 2) * grow + L / 2);
      p[k * 3] = wx + ox; p[k * 3 + 1] = drapeAt(wx + ox, wz + oz) + .002; p[k * 3 + 2] = wz + oz;
    }
    this.shadow.geometry.attributes.position.needsUpdate = true;
    this.shadowMat.opacity = 1 / (1 + lift * 2.2);
  }
  // a torn-off sheet: its desk texture is a downscaled copy of what's on the platen, so it's instant
  static fromSheet(s, vt, botJag, len = vt + JAG_A) {
    const H = Math.ceil(len * DPI), low = mkCanvas(Math.round(s.P.w * DESK_DPI), Math.ceil(len * DESK_DPI)), g = low.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(s.canvas, 0, 0, s.cw, H, 0, 0, low.width, low.height);
    if (botJag != null) { g.save(); g.scale(DESK_DPI / DPI, DESK_DPI / DPI); drawFringe(g, botJag, len - JAG_A, false, s.P); g.restore(); }
    return new Scrap({ len, ops: s.ops, topJag: s.topJag, botJag, desk: pickDeskSpot(len, s.P.w), P: s.P, seed: s.seed, lowMap: low });
  }
  static restore(d) {
    const P = { ...DEFAULT_SPEC, ...(d.P || {}) }, seed = d.seed ?? randSeed();
    const { x, z, yaw, seed: ds } = d.desk, desk = { x, z, yaw, seed: ds ?? randSeed() };
    const sc = new Scrap({ id: d.id, len: d.len, ops: unpackOps(d.ops, seed), topJag: d.topJag ?? null, botJag: d.botJag ?? null, desk, P, seed, created: d.created, folded: 0, marks: d.marks || [] });
    if (!d.trash) clampDesk(sc.desk, sc.effLen(), P.w);
    return sc;
  }
  serialize() {
    return { id: this.id, len: this.len, topJag: this.topJag, botJag: this.botJag, desk: this.desk, P: this.P, seed: this.seed, created: this.created, folded: this.folded, marks: this.marks.map(p => p.map(v => Math.round(v * 1000) / 1000)), trash: this.state === 'trash' ? 1 : 0, ops: packOps(this.ops) };
  }
  fromPaper(feed) {
    const a = new Float32Array(this.count * 3);
    for (let k = 0; k < this.count; k++) { sample(feed - this.sa[k]); a[k * 3] = this.xa[k]; a[k * 3 + 1] = PT.y; a[k * 3 + 2] = PT.z; }
    return a;
  }
  // resting on the desk (draped over what's beneath), or held flat at a fixed height while dragged
  deskVerts(fixedY = null) {
    const { x, z, yaw, seed } = this.desk, cy = Math.cos(yaw), sy = Math.sin(yaw), r = rng(seed), ph = r() * TAU, ph2 = r() * TAU;
    const a = new Float32Array(this.count * 3), L = this.len;
    for (let k = 0; k < this.count; k++) {
      let lx = this.xa[k], s = this.sa[k], fl = 0;
      // folding: the far half swings about the crease and settles face-down on the near half
      if (this.foldA > 0 && s > L / 2) { const d = s - L / 2; s = L / 2 + d * Math.cos(this.foldA); fl = d * Math.sin(this.foldA) + .006 * this.foldA / Math.PI + .012 * Math.sin(this.foldA / 2) * Math.exp(-d * 8); }
      const wx = x + lx * cy + s * sy, wz = z - lx * sy + s * cy;
      const curl = .008 * Math.pow(Math.abs(lx) / (this.P.w / 2), 3) + .014 * Math.pow(smooth(L - .5, L, s), 2) + .006 * Math.pow(smooth(.3, 0, s), 2)
        + .0015 * (1 + Math.sin(s * 1.3 + ph)) + .001 * (1 + Math.sin(lx * .9 + ph2));
      const base = fixedY != null ? fixedY + .05 * Math.sin(s * .8 + NOW * 2) * smooth(0, 3, s) : drapeAt(wx, wz) + .008;
      a[k * 3] = wx; a[k * 3 + 1] = base + curl + fl; a[k * 3 + 2] = wz;
    }
    return a;
  }
  inspectVerts(pan, tx = 0, ty = 0) {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]), up = new THREE.Vector3(e[4], e[5], e[6]), fwd = new THREE.Vector3(-e[8], -e[9], -e[10]);
    const tanV = Math.tan(deg(camera.fov / 2)), tanH = tanV * camera.aspect;
    const d = this.holdDist();
    const visH = 2 * d * tanV;
    const C = camera.position.clone().addScaledVector(fwd, d);
    this.C = C; this.up = up; this.fwd = fwd;
    const top = this.len < visH - .8 ? this.len / 2 : visH / 2 - .4;
    const a = new Float32Array(this.count * 3);
    for (let k = 0; k < this.count; k++) {
      const X = this.xa[k], Y = top - this.sa[k] + pan;
      const Z = .16 * Math.pow(X / 4.25, 2) + X * tx + Y * ty;
      a[k * 3] = C.x + right.x * X + up.x * Y + fwd.x * Z;
      a[k * 3 + 1] = C.y + right.y * X + up.y * Y + fwd.y * Z;
      a[k * 3 + 2] = C.z + right.z * X + up.z * Y + fwd.z * Z;
    }
    return a;
  }
  // how far from the eye to hold the sheet: its width fills ~70% of the view, and a short sheet fits whole
  holdDist() {
    const tanV = Math.tan(deg(camera.fov / 2)), tanH = tanV * camera.aspect;
    const dW = this.P.w / (.7 * 2 * tanH), dH = (this.len + .3) / (.78 * 2 * tanV);
    return Math.max(3.5, dW, Math.min(dH, dW * 1.3));
  }
  maxPan() { const tanV = Math.tan(deg(camera.fov / 2)); return Math.max(0, this.len - (2 * this.holdDist() * tanV - .8)); }
  flyTo(to, dur, arc, done, flutter = arc > 0 ? 1 : 0) { this.flight = { from: new Float32Array(this.pos), to, t0: NOW, dur, arc, done, flutter }; }
  commit() { const g = this.mesh.geometry; g.attributes.position.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere(); }
  update(dt) {
    if (this.flight) {
      const f = this.flight, t = clamp((NOW - f.t0) / f.dur, 0, 1), e = easeInOut(t), b = Math.sin(Math.PI * t);
      for (let k = 0; k < this.count; k++) {
        const i = k * 3;
        this.pos[i] = f.from[i] + (f.to[i] - f.from[i]) * e;
        this.pos[i + 1] = f.from[i + 1] + (f.to[i + 1] - f.from[i + 1]) * e + b * f.arc + f.flutter * b * b * .3 * (1 + Math.sin(this.sa[k] * 1.2 + t * 9)) * (.4 + Math.abs(this.xa[k]) / 8);
        this.pos[i + 2] = f.from[i + 2] + (f.to[i + 2] - f.from[i + 2]) * e;
      }
      this.commit();
      if (t >= 1) { this.flight = null; f.done && f.done(); if (this.state === 'desk') this.shadow.visible = !!this.shadowMat.map; }
      return true;
    } else if (this.state === 'drag') {
      this.desk.x += (drag.tx - this.desk.x) * (1 - Math.exp(-dt * 16));
      this.desk.z += (drag.tz - this.desk.z) * (1 - Math.exp(-dt * 16));
      this.desk.yaw += (drag.tyaw - this.desk.yaw) * (1 - Math.exp(-dt * 12));
      // near the bin the sheet rises by itself to clear the rim
      let near = 1e9; const W = this.P.w / 2, L = this.effLen();
      for (const lx of [-W, 0, W]) for (let ls = 0; ls <= L; ls += Math.max(.5, L / 6)) { const [wx, wz] = this.toWorld(lx, ls); near = Math.min(near, Math.hypot(wx - BASKET.x, wz - BASKET.z)); }
      const want = near < BASKET.r + .7 || drag.overBin ? Math.max(drag.y0, DESK_Y + BASKET.h + .4) : drag.y0;
      drag.y += (want - drag.y) * (1 - Math.exp(-dt * 10));
      this.updateShadow(Math.max(0, drag.y - drapeAt(...this.toWorld(0, this.len / 2)))); this.shadow.visible = true;
      this.settle(this.deskVerts(drag.y), 1 - Math.exp(-dt * 20));
      return true;
    } else if (this.state === 'inspect') {
      this.panS += (this.pan - this.panS) * (1 - Math.exp(-dt * 10));
      const tilt = tool === 'mark' || coarse ? 0 : 1;
      return this.settle(this.inspectVerts(this.panS, mouse.x * .07 * tilt, -mouse.y * .05 * tilt), 1 - Math.exp(-dt * 14));
    }
    return false;
  }
  // ease the mesh toward a target; skip the work once it has arrived
  settle(to, k) {
    let m = 0;
    for (let i = 0; i < this.pos.length; i++) { const d = to[i] - this.pos[i]; this.pos[i] += d * k; if (d > m) m = d; else if (-d > m) m = -d; }
    if (m < 2e-4) return false;
    this.commit(); return true;
  }
  dispose() {
    const q = texQueue.indexOf(this); if (q >= 0) texQueue.splice(q, 1);
    this.disposed = true;
    for (const c of [this.lowAlpha?.image, this.lowBase, this.lowMarks, this.shadowMat.map?.image]) if (c && 'width' in c) c.width = c.height = 1;
    this.shadowMat.dispose();
    this.releaseFull(); this.mesh.removeFromParent(); scene.remove(this.shadow); this.shadow.geometry.dispose(); this.shadowMat.map?.dispose(); this.lowTex.dispose(); this.lowAlpha.dispose(); this.lowMap.width = this.lowMap.height = 1; this.mesh.geometry.dispose(); this.mat.map.dispose(); this.mat.alphaMap.dispose(); this.mat.dispose(); }
}
function pickDeskSpot(len, w = 8.5) {
  const [x, z] = DESK_SPOTS[scraps.length % DESK_SPOTS.length];
  const d = { x: x + (Math.random() - .5) * .8, z: z + (Math.random() - .5) * .6, yaw: (Math.random() - .5) * .5, seed: randSeed() };
  clampDesk(d, len, w); return d;
}
// keep scraps off the machine's footprint
const BODY_FOOT = { x: 7.0, z: 5.95 };   // the machine's footprint on the desk (with a little clearance)
const BASKET = { x: -10.4, z: 2.2, r: 2.05, rb: 1.75, h: 3.4 };
function clampDesk(d, len, w = 8.5) {
  const cy = Math.cos(d.yaw), sy = Math.sin(d.yaw); let shift = 0;
  for (let lx = -w / 2; lx <= w / 2 + .01; lx += w / 4) for (let s = 0; s <= len + .5; s += .5) {
    const ss = Math.min(s, len), wx = d.x + lx * cy + ss * sy, wz = d.z - lx * sy + ss * cy;
    if (Math.abs(wx) < BODY_FOOT.x) shift = Math.max(shift, BODY_FOOT.z - wz);
  }
  d.z += shift;
  // and clear of the wastebasket
  for (let it = 0; it < 4; it++) {
    let worst = 0, wx0 = 0, wz0 = 0;
    for (let lx = -w / 2; lx <= w / 2 + .01; lx += w / 4) for (let s = 0; s <= len + .01; s += .5) {
      const wx = d.x + lx * cy + s * sy, wz = d.z - lx * sy + s * cy, dd = BASKET.r + .35 - Math.hypot(wx - BASKET.x, wz - BASKET.z);
      if (dd > worst) { worst = dd; wx0 = wx; wz0 = wz; }
    }
    if (worst <= 0) break;
    const L = Math.hypot(wx0 - BASKET.x, wz0 - BASKET.z) || 1; d.x += (wx0 - BASKET.x) / L * worst; d.z += (wz0 - BASKET.z) / L * worst;
  }
}
const maxDiff = (a, b) => { let m = 0; for (let i = 1; i < a.length; i += 3) m = Math.max(m, Math.abs(a[i] - b[i]), Math.abs(a[i - 1] - b[i - 1])); return m; };
// re-lay every scrap bottom-to-top; anything whose support changed settles to its new shape
// Re-lay the pile bottom-to-top. With a region, sheets that don't touch it keep their cached shape
// (they are still written into the heightfield); anything re-laid widens the region for sheets above.
const boxHit = (a, b) => a && b && a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0;
const boxJoin = (a, b) => !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), z0: Math.min(a.z0, b.z0), z1: Math.max(a.z1, b.z1) };
function rebuildDesk(animate = true, exclude = null, region = null) {
  hfReset();
  for (const s of scraps) {
    if (s === exclude) continue;
    let t = s.deskTarget;
    if (!region || !t || !s.bbox || boxHit(s.bbox, region) || s.relay) {
      s.relay = false;
      s.updateShadow();
      t = s.deskVerts(); s.deskTarget = t; s.bbox = footBox(s);
      if (region) region = boxJoin(region, s.bbox);
      if (s.state === 'desk') {
        if (!animate) { s.pos.set(t); s.commit(); }
        else if (maxDiff(s.pos, t) > .003) s.flyTo(t, .3, 0);
      }
    }
    hfRaster(s, t);
    s.shadow.visible = s.state === 'desk' && !!s.shadowMat.map;
  }
}
// ---------------------------------------------------------------- wastebasket
// A wire bin beside the machine. Drop a scrap on it and it's balled up and thrown in; click a ball to
// fish it back out. The bin keeps the last 20; older ones are gone for good.
const trash = [];
const TRASH_MAX = 20;
const basket = new THREE.Group(); basket.position.set(BASKET.x, DESK_Y, BASKET.z); scene.add(basket);
const basketRim = new THREE.MeshStandardMaterial({ color: 0x6a655d, roughness: .3, metalness: .85, emissive: 0xffc890, emissiveIntensity: 0 });
{
  const c = mkCanvas(512, 256), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 512, 256); g.fillStyle = '#fff';
  for (let x = 0; x < 512; x += 20) g.fillRect(x, 0, 7, 256);
  for (let y = 0; y < 256; y += 20) g.fillRect(0, y, 512, 6);
  const mesh = canvasTex(c, false); mesh.wrapS = mesh.wrapT = THREE.RepeatWrapping; mesh.repeat.set(3, 2);
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(BASKET.r, BASKET.rb, BASKET.h, 72, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x57524b, roughness: .38, metalness: .8, alphaMap: mesh, alphaTest: .35, side: THREE.DoubleSide }));
  wall.position.y = BASKET.h / 2; wall.castShadow = true; wall.receiveShadow = true; basket.add(wall);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(BASKET.r, .06, 12, 96).rotateX(Math.PI / 2), basketRim); rim.position.y = BASKET.h; rim.castShadow = true; basket.add(rim);
  const foot = new THREE.Mesh(new THREE.TorusGeometry(BASKET.rb, .05, 10, 96).rotateX(Math.PI / 2), basketRim); foot.position.y = .07; basket.add(foot);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(BASKET.rb, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1c1b19, roughness: .6, metalness: .5 }));
  floor.position.y = .03; floor.receiveShadow = true; basket.add(floor);
  // soft contact shadow on the desk
  const sc = mkCanvas(128, 128), sg = sc.getContext('2d'), gr = sg.createRadialGradient(64, 64, 30, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); sg.fillStyle = gr; sg.fillRect(0, 0, 128, 128);
  const ao = new THREE.Mesh(new THREE.PlaneGeometry(BASKET.rb * 2.8, BASKET.rb * 2.8), new THREE.MeshBasicMaterial({ map: canvasTex(sc, false), transparent: true, depthWrite: false }));
  ao.rotation.x = -Math.PI / 2; ao.position.y = .004; basket.add(ao);
}
// crumpled: the sheet wrapped onto a lumpy ball, with crease noise
function ballVerts(s, C, R) {
  const r = rng(s.seed ^ 0x5bd1e995), a = new Float32Array(s.count * 3), PW = s.P.w;
  const lumps = Array.from({ length: 6 }, () => [r() * TAU, r() * Math.PI, .12 + r() * .18]);
  for (let k = 0; k < s.count; k++) {
    const u = s.xa[k] / PW + .5, v = s.sa[k] / s.len;
    const th = u * TAU * 1.08 + Math.sin(v * 9 + u * 4) * .35, ph = .18 + v * (Math.PI - .36) + Math.sin(u * 11) * .12;
    let rr = R * (.8 + .12 * Math.sin(u * 23 + v * 17) + .08 * Math.sin(u * 7 - v * 29));
    for (const [lt, lp, amt] of lumps) rr += R * amt * Math.max(0, Math.cos(th - lt) * Math.sin(ph) * Math.sin(lp) + Math.cos(ph) * Math.cos(lp) - .6);
    a[k * 3] = C.x + rr * Math.sin(ph) * Math.cos(th); a[k * 3 + 1] = C.y + rr * Math.cos(ph) * .92; a[k * 3 + 2] = C.z + rr * Math.sin(ph) * Math.sin(th);
  }
  return a;
}
const ballR = s => Math.min(.62, .42 + s.len * .02);
function trashSlot(i) {
  const ang = i * 2.39996, rad = [0, .75, .75, .75][i % 4];
  return new THREE.Vector3(BASKET.x + Math.cos(ang) * rad, DESK_Y + .6 + Math.floor(i / 4) * .6, BASKET.z + Math.sin(ang) * rad);
}
const overBin = R => new THREE.Vector3(BASKET.x, DESK_Y + BASKET.h + R + .45, BASKET.z);
function placeTrash(animate) {
  while (trash.length > TRASH_MAX) deleteForever(trash[0]);
  trash.forEach((s, i) => {
    if (s.state === 'flying') return;
    s.state = 'trash'; s.shadow.visible = false; s.mesh.castShadow = true;
    const t = ballVerts(s, trashSlot(i), ballR(s));
    if (animate) s.flyTo(t, .5, 0, null, 0); else { s.pos.set(t); s.commit(); }
  });
}
function trashScrap(s) {
  const region = s.bbox;
  scraps.splice(scraps.indexOf(s), 1); trash.push(s);
  s.state = 'trash'; s.dirty = true; s.shadow.visible = false;
  rebuildDesk(true, null, region);
  Sound.crumple();
  const i = trash.length - 1, R = ballR(s);
  s.state = 'flying';
  placeTrash(false);
  // ball it up above the opening, then let it drop in
  s.flyTo(ballVerts(s, overBin(R), R), .65, 1.3, () => s.flyTo(ballVerts(s, trashSlot(trash.indexOf(s)), R), .32, 0, () => { s.state = 'trash'; Sound.bin(); }, 0), 0);
  toast('in the bin · click it to take it back'); scheduleSave(); updateTools();
}
function restoreFromTrash(s) {
  trash.splice(trash.indexOf(s), 1);
  s.desk = pickDeskSpot(s.effLen(), s.P.w); s.dirty = true; s.state = 'flying';
  scraps.push(s); rebuildDesk(true, null, footBox(s));
  Sound.rustle();
  // lift it clear of the rim first, then smooth it out on the way to the desk
  const R = ballR(s);
  s.flyTo(ballVerts(s, overBin(R), R), .35, 0, () => s.flyTo(s.deskTarget, .95, .7, () => { s.state = 'desk'; s.shadow.visible = !!s.shadowMat.map; Sound.flop(.24); }, 0), 0);
  placeTrash(true); scheduleSave(); updateTools();
}
// ---------------------------------------------------------------- gone for good
// The bin is the only way out: a sheet goes in the bin, and emptying the bin deletes it permanently.
// Clearing the desk sweeps everything into the bin and empties it, after asking.
function deleteForever(s) {
  removedIds.add(s.id);
  for (const arr of [scraps, trash]) { const i = arr.indexOf(s); if (i >= 0) arr.splice(i, 1); }
  for (let i = markUndo.length - 1; i >= 0; i--) if (markUndo[i] === s) markUndo.splice(i, 1);
  if (hovered === s) hovered = null;
  s.dispose(); doomed.delete(s); updateTools(); scheduleSave();
}
// the ball sinks to the bottom of the bin and is gone
function sinkAndDelete(s, delay = 0) {
  const R = ballR(s);
  setTimeout(() => s.flyTo(ballVerts(s, new THREE.Vector3(BASKET.x, DESK_Y + .2, BASKET.z), R * .25), .4, 0, () => deleteForever(s), 0), delay);
}
async function emptyBin() {
  if (!trash.length) return;
  const n = trash.length;
  if (!(await confirmBox(`Empty the bin? ${n} sheet${n > 1 ? 's' : ''} will be gone for good.`, 'Empty bin'))) return;
  for (const s of trash) { doomed.add(s); removedIds.add(s.id); }
  save();
  [...trash].forEach((s, i) => { s.state = 'flying'; sinkAndDelete(s, i * 45); });
  for (let k = 0; k < Math.min(3, n); k++) setTimeout(() => Sound.bin(), k * 140);
  setTimeout(() => { scheduleSave(); updateTools(); }, n * 45 + 500);
  toast('bin emptied');
}
async function clearDesk() {
  const n = scraps.length + trash.length;
  if (!n) return;
  if (!(await confirmBox(`Clear the desk? All ${n} sheet${n > 1 ? 's' : ''}, including the bin, will be gone for good.`, 'Clear desk'))) return;
  for (const s of [...scraps, ...trash]) { doomed.add(s); removedIds.add(s.id); }
  kept.order.length = kept.trash.length = 0;
  save();
  if (inspecting) { heldScene.remove(inspecting.mesh); scene.add(inspecting.mesh); inspecting.releaseFull(); inspecting = null; setHelp(HELP_TYPE); actionsEl.classList.remove('on'); updateTools(); }
  const sheets = [...scraps]; scraps.length = 0; hfReset();
  for (const s of trash) { s.state = 'flying'; }
  [...trash].forEach((s, i) => sinkAndDelete(s, i * 30));
  // every sheet balls up over the bin and drops through it
  sheets.forEach((s, i) => {
    trash.push(s); s.state = 'flying'; s.shadow.visible = false;
    const R = ballR(s);
    setTimeout(() => s.flyTo(ballVerts(s, overBin(R), R), .55, 1.1, () => sinkAndDelete(s), 0), 120 + i * 40);
  });
  for (let k = 0; k < Math.min(4, sheets.length); k++) setTimeout(() => Sound.crumple(), 120 + k * 160);
  setTimeout(() => { scheduleSave(); updateTools(); }, 900 + sheets.length * 40);
  toast('desk cleared'); updateTools();
}
function throwAwayHeld() {
  const s = inspecting; if (!s) return;
  inspecting = null; heldScene.remove(s.mesh); scene.add(s.mesh); s.releaseFull();
  setHelp(HELP_TYPE); actionsEl.classList.remove('on'); updateTools();
  s.state = 'desk'; trashScrap(s); updateTools();
}
// a small, honest confirmation for things that can't be undone
const confirmEl = document.getElementById('confirm');
let confirmOpen = false;
function confirmBox(msg, okLabel) {
  return new Promise(resolve => {
    confirmEl.querySelector('p').textContent = msg;
    confirmEl.querySelector('[value="ok"]').textContent = okLabel;
    confirmEl.returnValue = '';   // Esc closes without setting it, so a stale 'ok' must never survive
    confirmOpen = true; confirmEl.showModal(); confirmEl.querySelector('[value="cancel"]').focus();
    confirmEl.addEventListener('close', () => { confirmOpen = false; resolve(confirmEl.returnValue === 'ok'); }, { once: true });
  });
}

// ---------------------------------------------------------------- tidy the desk
// Laid out in a neat grid in front of the machine, read like a page: oldest top-left, each day
// starting a new row, sheets aligned by their top edges, square to the desk.
function tidyDesk() {
  if (!scraps.length) { lcdMessage('DESK IS CLEAR', 1.2); return; }
  const day = t => new Date(t).toDateString();
  const sorted = [...scraps].sort((a, b) => a.created - b.created);
  const GAP = .7, cols = clamp(Math.round(Math.sqrt(sorted.length) * 1.4), 2, 7);
  const rows = []; let row = null;
  for (const s of sorted) {
    if (!row || row.items.length >= cols || row.day !== day(s.created)) { row = { day: day(s.created), items: [] }; rows.push(row); }
    row.items.push(s);
  }
  let z = BODY_FOOT.z + .8;
  for (const r of rows) {
    const width = r.items.reduce((a, s) => a + s.P.w, 0) + GAP * (r.items.length - 1);
    let x = -width / 2;
    for (const s of r.items) { s.desk = { x: x + s.P.w / 2, z, yaw: 0, seed: s.desk.seed }; s.dirty = true; x += s.P.w + GAP; }
    z += Math.max(...r.items.map(s => s.effLen())) + GAP * 1.4;
  }
  scraps.length = 0; scraps.push(...sorted);
  rebuildDesk(true);
  scraps.forEach((s, k) => { if (s.state === 'desk') { s.flyTo(s.deskTarget, .7 + k * .02, .6, null, 0); s.shadow.visible = false; setTimeout(() => { s.shadow.visible = !!s.shadowMat.map; }, (.72 + k * .02) * 1000); } });
  for (let k = 0; k < Math.min(6, scraps.length); k++) setTimeout(() => Sound.rustle(), k * 110);
  deskPan.set(0, 0, 0); overviewBox = null; setView(3);
  lcdMessage(`TIDIED · ${scraps.length} SHEET${scraps.length > 1 ? 'S' : ''}`, 1.6); scheduleSave();
}
function footBox(s) {
  const L = s.effLen(), w = s.P.w / 2 + .4; let b = null;
  for (const [lx, ls] of [[-w, -.4], [w, -.4], [-w, L + .4], [w, L + .4]]) { const [x, z] = s.toWorld(lx, ls); b = boxJoin(b, { x0: x, x1: x, z0: z, z1: z }); }
  return b;
}
// Compact text storage: runs of consecutive characters on one line, ~1 byte per character.
// Per-character seeds come from the sheet seed and the character's index, weights from the glyph,
// and overstrike counts are recomputed, so nothing else needs storing.
function packOps(ops) {
  const r = [], e = []; let run = null;
  ops.forEach((o, i) => {
    const v = Math.round(o.v * 1000), h = o.h == null ? '-' : String(Math.round(o.h * 9));
    if (run && run[0] === v && run[1] + run[2].length === o.col) { run[2] += o.ch; run[3] += h; }
    else { run = [v, o.col, o.ch, h]; r.push(run); }
    if (o.erased) e.push(i);
  });
  for (const x of r) if (/^-+$/.test(x[3])) x.length = 3;   // older ink has no recorded heat
  return { r, e };
}
function unpackOps(pk, seed) {
  if (!pk) return [];
  if (Array.isArray(pk)) return tagOverstrikes(pk.map(([ch, col, v, sd, w, e]) => ({ ch, col, v, seed: sd, w, erased: !!e })));   // v1 format
  const ops = [], er = new Set(pk.e || []);
  for (const [v, col, text, heat] of pk.r) {
    let c = col, j = 0;
    for (const ch of text) {
      const i = ops.length, d = heat ? heat[j] : '-'; j++;
      ops.push({ ch, col: c++, v: v / 1000, seed: mixSeed(seed, i), w: hammerWeight(ch), erased: er.has(i), h: d && d !== '-' ? +d / 9 : undefined });
    }
  }
  return tagOverstrikes(ops);
}
function tagOverstrikes(ops) {
  const cell = new Set(); for (const o of ops) if (o.ch !== '_') cell.add(`${Math.round(o.v * 100)}:${o.col}`);
  for (const o of ops) if (o.ch === '_' && cell.has(`${Math.round(o.v * 100)}:${o.col}`)) o.w = .7;
  const seen = new Map();
  for (const o of ops) { if (o.erased) continue; const k = `${Math.round(o.v * 100)}:${o.col}:${o.ch}`; o.ov = seen.get(k) || 0; seen.set(k, o.ov + 1); }
  return ops;
}
function opsToText(ops) {
  const lines = new Map();
  for (const o of ops) {
    if (o.erased) continue; const key = Math.round(o.v * 48); if (!lines.has(key)) lines.set(key, []);
    const L = lines.get(key), prev = L[o.col];
    if (!prev || prev === ' ' || (prev === '_' && o.ch !== '_')) L[o.col] = o.ch;   // an overstrike never hides the letter under it
  }
  const keys = [...lines.keys()].sort((a, b) => a - b); const out = []; let prev = null;
  for (const k of keys) {
    if (prev != null) { const gap = Math.round((k - prev) / 8) - 1; for (let i = 0; i < gap; i++) out.push(''); }
    out.push(Array.from(lines.get(k), c => c || ' ').join('').replace(/\s+$/, '')); prev = k;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- mechanism state & jobs
// Thermal line printing (Typestar-style): the head locks onto the platen, glides across at a
// steady speed burning each character in as it passes, releases, the platen feeds, and the
// carriage runs back to the margin.
const hx = col => colX(col) - PITCH / 2;         // head sits at the left edge of a column
const PRINT_SPEED = 2.3, RETURN_SPEED = 5.2;     // inches per second
const Mech = { x: hx(0), lock: 0, lockT: 0, ribbon: 0, burn: 0 };
const pn = x => x / 5;
const queue = []; let busy = false;
function enqueue(job) { queue.push(job); pump(); }
async function pump() {
  if (busy) return; busy = true;
  while (queue.length) { const j = queue.shift(); try { await j(); } catch (e) { console.error(e); } }
  busy = false; scheduleSave();
}
async function moveHead(x) {
  const dist = Math.abs(x - Mech.x); if (dist < .005) return;
  const dur = dist < .35 ? .05 + dist * .25 : .14 + dist / RETURN_SPEED;
  Sound.travel(dur, dist, pn(Mech.x), pn(x), dist > 1 && x < Mech.x);
  await tweenProp(Mech, 'x', x, dur);
}
async function lockHead(soft = false) {
  if (Mech.lockT === 1) return;
  Sound.lock(pn(Mech.x), soft); Mech.lockT = 1; await wait(soft ? .07 : .22);
}
async function releaseHead(soft = false) {
  if (Mech.lockT === 0) return;
  Sound.release(pn(Mech.x), soft); await wait(soft ? .02 : .12); Mech.lockT = 0; await wait(soft ? .05 : .26);
}
async function printRun(x1, onStep) {
  const x0 = Mech.x, dur = Math.abs(x1 - x0) / PRINT_SPEED;
  Sound.print(dur, pn(x0), pn(x1));
  await tween(dur, e => {
    const x = x0 + (x1 - x0) * e; Mech.ribbon += Math.abs(x - Mech.x); Mech.x = x; Mech.burn = 1;
    sheet.revealTo(x); onStep && onStep(x);
  }, linear);
  sheet.revealTo(x1 + .3);
}
async function moveCarrier(col) { await moveHead(hx(col)); }
async function carriageReturn() { await moveHead(hx(0)); }
async function lineFeed(n = 1) {
  n *= SPACINGS[feedSpacing];
  const to = sheet.feed + LINE_H * n;
  if (sheet.P.type === 'card' && to > CARD_LEN - .3) { lcdMessage('END OF CARD', 1); await ejectCardJob(); return; }
  if (to > MAX_FEED) { toast('end of roll: tearing off'); await tearJob(); return; }
  const dur = .2 + .06 * n;
  Sound.lf(dur, LINE_H * n);
  await wait(.03);
  await tweenProp(sheet, 'feed', to, dur);
}
async function printLineJob(line) {
  printing = line;
  const t = line.text, first = t.search(/\S/);
  if (first >= 0) {
    for (let i = first; i < t.length; i++) if (t[i] !== ' ') sheet.addPending(t[i], line.startCol + i, hammerWeight(t[i]));
    await moveHead(hx(line.startCol + first));
    await lockHead();
    await printRun(hx(line.startCol + t.length), x => {
      const d = clamp(Math.floor((x - hx(line.startCol)) / PITCH + .5), 0, t.length);
      if (d !== line.done) { line.done = d; lcdDirty = true; }
    });
    line.done = t.length; lcdDirty = true;
    // second pass: back to the first styled character, re-strike bold ones a hair to the right, underscore underlined ones
    const A = line.attrs || [], styled = [];
    for (let i = 0; i < t.length; i++) if (A[i]) styled.push(i);
    if (styled.length) {
      const a = styled[0], b = styled[styled.length - 1];
      await releaseHead(true);
      await moveHead(hx(line.startCol + a));
      for (const i of styled) {
        if (A[i] & BOLD && t[i] !== ' ') sheet.addPending(t[i], line.startCol + i, hammerWeight(t[i]));
        if (A[i] & UNDER) sheet.addPending('_', line.startCol + i, .7);
      }
      await lockHead(true);
      await printRun(hx(line.startCol + b + 1));
    }
    await releaseHead();
  }
  await lineFeed(1);
  await carriageReturn();
  printing = null; lcdDirty = true;
}
let releaseTimer = 0;
function scheduleRelease() { clearTimeout(releaseTimer); releaseTimer = setTimeout(() => enqueue(() => releaseHead(true)), 520); }
async function tearJob() {
  await releaseHead();
  if (sheet.P.type === 'card') return ejectCardJob();
  const s = sheet, last = s.lastInkV();
  const need = Math.max(last >= 0 ? last + .22 + U_TEAR : 0, U_TEAR + .7);
  if (s.feed < need) { const d = need - s.feed; Sound.lf(.2 + d * .2, d); await Promise.all([carriageReturn(), tweenProp(s, 'feed', need, .2 + d * .2)]); }
  else await carriageReturn();
  await wait(.18);
  const vt = s.feed - U_TEAR, seed = tearSeed(s.P.type === 'fan');
  const scrap = Scrap.fromSheet(s, vt, seed);
  scrap.pos.set(scrap.fromPaper(s.feed)); scrap.commit();
  setSheet(new Sheet({ feed: U_TEAR + JAG_A, topJag: seed, P: { ...s.P, v0: s.P.v0 + vt - JAG_A } }));
  lastFeedDrawn = NaN;   // (the typing position was reset when the tear was asked for)
  Sound.tear();
  landScrap(scrap);
  lcdMessage('TORN OFF', 1.2);
  await wait(.35);
  // feed a little fresh paper up past the tear bar
  // printer-style: after the tear-off, roll the fresh edge back down so the next scrap has a small top margin
  { const to = JAG_A + .42, d = sheet.feed - to; Sound.lf(.25 + d * .3, d); await tweenProp(sheet, 'feed', to, .25 + d * .3); }
  scheduleSave();
}

// a new sheet goes onto the desk: on top of the pile, flying out of the machine
function landScrap(scrap) {
  scrap.state = 'flying'; scrap.dirty = true;
  scraps.push(scrap); rebuildDesk(true, null, footBox(scrap));
  glance();
  scrap.flyTo(scrap.deskTarget, 1.25, 2.4, () => { scrap.state = 'desk'; Sound.flop(.32); scheduleSave(); });
}
// index cards come out whole: feed the card clear of the platen, send it to the desk, load the next
async function ejectCardJob() {
  const s = sheet;
  await carriageReturn();
  const out = CARD_LEN + .9, d = out - s.feed; Sound.lf(.3 + d * .25, d); await tweenProp(s, 'feed', out, .3 + d * .25);
  if (s.lastInkV() >= 0) {
    const scrap = Scrap.fromSheet(s, CARD_LEN, null, CARD_LEN);
    scrap.pos.set(scrap.fromPaper(s.feed)); scrap.commit();
    Sound.flop(.2); landScrap(scrap); lcdMessage('CARD OUT', 1.2);
  }
  setSheet(new Sheet({ feed: 0, P: cardSpec(LINE_H * SPACINGS[feedSpacing]) }));
  await wait(.3);
  Sound.lf(.7, CARD_TOP); await tweenProp(sheet, 'feed', CARD_TOP, .7);
  scheduleSave();
}

// changing paper: tear off what's printed, rewind the rest, move the guides, load the new roll
function specFor(next) { return next.type === 'card' ? cardSpec(LINE_H * SPACINGS[feedSpacing]) : paperSpec(next.wi, next.type); }
function queuePaperChange(next) {
  targetP = specFor(next); paperChanges++;
  // a new sheet starts at the left margin: reset the typing position now, at the key press
  const cols = COLS_NOW();
  charCol = 0; charLine = ''; charA = []; lineStartCol = 0; buf = buf.slice(0, cols); bufA = bufA.slice(0, buf.length); cur = Math.min(cur, buf.length); lcdOff = 0;
  enqueue(async () => { try { await changePaperJob(next); } finally { if (--paperChanges === 0) targetP = null; } });
}
async function changePaperJob(next) {
  await releaseHead();
  if (sheet.lastInkV() >= 0) await tearJob();
  { const d = sheet.feed; Sound.lf(.35 + d * .3, d); await tweenProp(sheet, 'feed', 0, .35 + d * .3); }
  const wi = next.wi, type = next.type, P = specFor(next);
  if (Math.abs(ctl.guideW - P.w) > .01) {
    const from = ctl.guideW, to = P.w, dur = .25 + Math.abs(to - from) * .12;
    Sound.travel(dur, Math.abs(to - from), 0, 0, false);
    await tween(dur, e => { ctl.guideW = from + (to - from) * e; });
  }
  setSheet(new Sheet({ feed: 0, P }));
  await carriageReturn();
  const top = type === 'card' ? CARD_TOP : .9;
  Sound.lf(1.0, top); await tweenProp(sheet, 'feed', top, 1.0);
  lcdMessage(type === 'card' ? `INDEX CARD 5×3 · ${specCols(P)} COL` : `${WIDTHS[wi].label}" ${type === 'fan' ? 'FANFOLD' : 'ROLL'} · ${specCols(P)} COL`, 1.8);
  lcdDirty = true; scheduleSave();
}
function useControl(name) {
  Sound.resume();
  if (name === 'spacing') {
    ctl.spacing = (ctl.spacing + 1) % SPACINGS.length;
    Sound.knob(); lcdMessage(`LINE SPACE ${['1', '1½', '2'][ctl.spacing]}`, 1.1);
    // the lever moves now, but the new spacing takes effect in turn, after lines already queued to print;
    // a card in the machine is re-ruled from the current line down at that moment
    const sp = ctl.spacing;
    enqueue(async () => {
      feedSpacing = sp;
      if (sheet.P.type !== 'card') return;
      const cur = Math.max(CARD_TOP, sheet.feed), keep = (sheet.P.rules || []).filter(v => v < cur + RULE_OFF - .01);
      sheet.P.rules = cardRules(cur, LINE_H * SPACINGS[sp], keep);
      sheet.compositeRect(0, 0, sheet.cw, CARD_LEN * DPI + 4);
    });
    scheduleSave(); return;
  }
  if (name === 'paper') {
    ctl.paper = (ctl.paper + 1) % PAPER_TYPES.length; Sound.knob();
    queuePaperChange({ type: PAPER_TYPES[ctl.paper], wi: ctl.wi }); return;
  }
  if (name === 'width') {
    ctl.wi = (ctl.wi + 1) % WIDTHS.length; Sound.knob();
    queuePaperChange({ type: PAPER_TYPES[ctl.paper], wi: ctl.wi }); return;
  }
}

// ---------------------------------------------------------------- typing state
let mode = 'line';                 // 'line' | 'char'
let buf = '', cur = 0, lineStartCol = 0, lcdOff = 0;
// Bold and underline, the line-memory way: toggled with Ctrl B / Ctrl U while typing. Each character
// carries its style (bit 1 = bold, bit 2 = underline); the machine adds the extra strikes itself.
const BOLD = 1, UNDER = 2;
let style = 0, bufA = [], charA = [];
let printing = null;
let charCol = 0, charLine = '';
function toggleStyle(bit) { style ^= bit; Sound.beep(style & bit ? 2400 : 1800, .04, .035); lcdDirty = true; updateTouchbar(); }
let caps = false, powered = false, inspecting = null;
let lcdDirty = true, lcdMsg = null, lcdMsgUntil = 0;
function lcdMessage(m, sec) { lcdMsg = m; lcdMsgUntil = NOW + sec; lcdDirty = true; }

const ALLOWED = /^[ -ɏ‘’“”–—…°]$/u;
function printable(e) { return e.key.length === 1 && ALLOWED.test(e.key); }

function lineKey(e) {
  const k = e.key;
  if (printable(e)) {
    if (lineStartCol + buf.length >= COLS_NOW()) { Sound.error(); return; }
    buf = buf.slice(0, cur) + k + buf.slice(cur); bufA.splice(cur, 0, k === ' ' ? style & UNDER : style); cur++; Sound.key();
    if (lineStartCol + buf.length === BELL_NOW()) Sound.beep();
  } else if (k === 'Backspace') {
    if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); bufA.splice(cur - 1, 1); cur--; Sound.key(); } else Sound.error();
  } else if (k === 'Delete') {
    if (cur < buf.length) { buf = buf.slice(0, cur) + buf.slice(cur + 1); bufA.splice(cur, 1); Sound.key(); }
  } else if (k === 'ArrowLeft') { if (cur > 0) cur--; Sound.key(); }
  else if (k === 'ArrowRight') { if (cur < buf.length) cur++; Sound.key(); }
  else if (k === 'Home') cur = 0;
  else if (k === 'End') cur = buf.length;
  else if (k === 'Tab') {
    const n = 5 - ((lineStartCol + cur) % 5);
    if (lineStartCol + buf.length + n > COLS_NOW()) { Sound.error(); return; }
    buf = buf.slice(0, cur) + ' '.repeat(n) + buf.slice(cur); bufA.splice(cur, 0, ...Array(n).fill(0)); cur += n; Sound.key();
  } else if (k === 'Enter') {
    Sound.key(true);
    const text = buf.replace(/\s+$/, '');
    const line = { text, attrs: bufA.slice(0, text.length), startCol: lineStartCol, done: 0 };
    buf = ''; bufA = []; cur = 0; lcdOff = 0; lineStartCol = 0;
    enqueue(() => printLineJob(line));
  } else return;
  lcdDirty = true;
}
function charKey(e) {
  const k = e.key;
  if (printable(e) || k === 'ArrowRight' || k === 'Tab') {
    const ch = k === 'ArrowRight' || k === 'Tab' ? ' ' : k;
    const n = k === 'Tab' ? 5 - (charCol % 5) : 1;
    if (charCol + n > COLS_NOW()) { Sound.error(); return; }
    Sound.key();
    for (let i = 0; i < n; i++) {
      const col = charCol++, st = ch === ' ' ? style & UNDER : style; charLine += ch; charA.push(st);
      enqueue(async () => {
        clearTimeout(releaseTimer);
        if (Mech.lockT === 0) await moveHead(hx(col));
        if (ch !== ' ') sheet.addPending(ch, col, hammerWeight(ch));
        if (ch !== ' ' && st & BOLD) sheet.addPending(ch, col, hammerWeight(ch));
        if (st & UNDER) sheet.addPending('_', col, .7);
        if (ch !== ' ' || st & UNDER) await lockHead(true);
        if (Mech.lockT === 1) await printRun(hx(col + 1)); else await moveHead(hx(col + 1));
        if (!queue.length) scheduleRelease();
      });
    }
    if (charCol === BELL_NOW()) Sound.beep();
  } else if (k === 'Backspace' || k === 'ArrowLeft') {
    if (charCol === 0) { Sound.error(); return; }
    Sound.key();
    const col = --charCol; charLine = charLine.slice(0, -1); charA.pop();
    if (k === 'ArrowLeft') enqueue(async () => { clearTimeout(releaseTimer); await releaseHead(true); await moveCarrier(col); });
    else enqueue(async () => {
      // lift-off: back up, press the correction film onto the character and run over it; every layer
      // in that column (letter, bold strike, underline) comes away as the head passes
      clearTimeout(releaseTimer);
      const ops = sheet.findOps(col);
      await releaseHead(true); await moveCarrier(col);
      if (!ops.length) return;
      Sound.correct(pn(Mech.x)); Mech.lockT = 1; await wait(.08);
      for (const o of ops) o.erased = true;
      burnHeat(null, .6);
      await printRun(hx(col + 1), x => sheet.liftTo(ops, x)); sheet.liftTo(ops, hx(col + 1) + .3);
      Sound.peel(pn(Mech.x));
      await releaseHead(true); await moveCarrier(col);
    });
  } else if (k === 'Enter') {
    Sound.key(true); charCol = 0; charLine = ''; charA = [];
    enqueue(async () => { clearTimeout(releaseTimer); await releaseHead(); await lineFeed(1); await carriageReturn(); });
  } else return;
  lcdDirty = true;
}
function toggleMode() {
  if (mode === 'line') {
    if (buf.length) { Sound.error(); lcdMessage('PRINT LINE FIRST', 1.2); return; }
    mode = 'char'; charCol = lineStartCol; charLine = ''; charA = [];
    enqueue(() => moveCarrier(charCol));
  } else {
    enqueue(() => releaseHead(true));
    mode = 'line'; lineStartCol = charCol; buf = ''; bufA = []; cur = 0;
  }
  Sound.beep(2400, .05, .04); lcdDirty = true; scheduleSave(); updateTouchbar();
}
function knob(dir) {
  Sound.key();
  enqueue(async () => {
    const to = clamp(sheet.feed + dir * LINE_H / 2, .35, MAX_FEED); if (to === sheet.feed) return;
    Sound.knob(); await tweenProp(sheet, 'feed', to, .09);
  });
}
let tearQueued = false;
function requestTear() {
  if (tearQueued) return;
  const pending = busy || queue.length;
  if (!pending && sheet.lastInkV() < 0 && sheet.feed < U_TEAR + 1) { Sound.error(); lcdMessage('NOTHING TO TEAR', 1); return; }
  Sound.key(true); tearQueued = true;
  // the typing position belongs to the next sheet from this key on
  charCol = 0; charLine = ''; charA = [];
  enqueue(async () => {
    try {
      if (sheet.lastInkV() < 0 && sheet.feed < U_TEAR + 1) { Sound.error(); lcdMessage('NOTHING TO TEAR', 1); return; }
      await tearJob();
    } finally { tearQueued = false; }
  });
}

// ---------------------------------------------------------------- LCD drawing
function lcdView() {
  if (lcdMsg && NOW < lcdMsgUntil) { const pad = Math.max(0, (LCD_CELLS - lcdMsg.length) >> 1); return { text: ' '.repeat(pad) + lcdMsg, cursor: -1, start: 0, col: null }; }
  if (mode === 'char') {
    const start = Math.max(0, charLine.length - (LCD_CELLS - 1));
    return { text: charLine, attrs: charA, cursor: charLine.length, start, col: charCol };
  }
  if (!buf.length && printing) {
    const t = ' '.repeat(printing.done) + printing.text.slice(printing.done);
    return { text: t, attrs: (printing.attrs || []).map((x, i) => i < printing.done ? 0 : x), cursor: -1, start: Math.max(0, Math.min(printing.done, t.length - LCD_CELLS)), col: printing.startCol + printing.done };
  }
  if (cur < lcdOff) lcdOff = cur;
  if (cur > lcdOff + LCD_CELLS - 1) lcdOff = cur - (LCD_CELLS - 1);
  return { text: buf, attrs: bufA, cursor: cur, start: lcdOff, col: lineStartCol + cur };
}
let blinkOn = true;
function drawLCD() {
  const g = lcdCtx;
  const bg = g.createLinearGradient(0, 0, 0, LCD_H); bg.addColorStop(0, '#a9b29a'); bg.addColorStop(1, '#949e85');
  g.fillStyle = bg; g.fillRect(0, 0, LCD_W, LCD_H);
  const v = lcdView();
  const onC = 'rgba(22,28,18,0.92)', offC = 'rgba(30,40,24,0.07)';
  g.font = '600 17px "IBM Plex Mono", monospace'; g.textBaseline = 'middle';
  const ind = (t, x, on) => { g.fillStyle = on ? onC : offC; g.fillText(t, x, 22); };
  ind('LINE', 30, powered && mode === 'line'); ind('CHAR', 92, powered && mode === 'char');
  ind('CAPS', 160, powered && caps);
  // line-space indicator: a drawn double arrow (the LCD font has no ↕) and the setting
  g.fillStyle = powered ? onC : offC;
  g.fillRect(231, 13, 2, 18); g.beginPath(); g.moveTo(226, 16); g.lineTo(232, 9); g.lineTo(238, 16); g.fill(); g.beginPath(); g.moveTo(226, 28); g.lineTo(232, 35); g.lineTo(238, 28); g.fill();
  ind(['1', '1½', '2'][ctl.spacing], 244, powered);
  ind(['ROLL', 'FAN', 'CARD'][ctl.paper], 300, powered);
  ind('♪', 366, powered && v.col != null && v.col >= BELL_NOW());
  ind('◂', 392, powered && v.start > 0);
  ind('B', 426, powered && !!(style & BOLD));
  g.fillStyle = powered && style & UNDER ? onC : offC; g.fillText('U', 452, 22); g.fillRect(451, 32, 12, 2);
  // column ruler
  const rx0 = 488, rx1 = 1080;
  g.fillStyle = powered ? 'rgba(22,28,18,0.35)' : offC; g.fillRect(rx0, 21, rx1 - rx0, 2);
  for (let c = 0; c <= COLS_NOW(); c += 5) g.fillRect(rx0 + (rx1 - rx0) * c / COLS_NOW() - 1, c % 10 ? 17 : 13, 2, c % 10 ? 5 : 9);
  if (powered && v.col != null) { g.fillStyle = onC; const px = rx0 + (rx1 - rx0) * Math.min(v.col, COLS_NOW()) / COLS_NOW(); g.beginPath(); g.moveTo(px, 26); g.lineTo(px - 6, 36); g.lineTo(px + 6, 36); g.fill(); }
  // characters left on the line
  const left = v.col != null ? Math.max(0, COLS_NOW() - v.col) : null;
  g.textAlign = 'right'; ind(left != null ? `${String(left).padStart(2, ' ')} LEFT` : '-- LEFT', 1272, powered); g.textAlign = 'left';
  // characters
  const P = 6.6, D = 5.5, x0 = (LCD_W - LCD_CELLS * 40) / 2 + 3, y0 = 50;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < LCD_CELLS; i++) {
      const ch = powered ? (v.text[v.start + i] ?? ' ') : ' ', at = powered && v.attrs ? v.attrs[v.start + i] | 0 : 0;
      const rows = romGlyph(ch), cx = x0 + i * 40;
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
        // bold: each lit dot also lights its right-hand neighbour
        const lit = ((rows[r] >> (4 - c)) & 1) || (at & BOLD && c > 0 && (rows[r] >> (5 - c)) & 1);
        if (pass === 0) { if (lit) { g.fillStyle = 'rgba(30,40,24,0.16)'; g.fillRect(cx + c * P + 2, y0 + r * P + 2, D, D); } }
        else { g.fillStyle = lit ? onC : offC; g.fillRect(cx + c * P, y0 + r * P, D, D); }
      }
      if (pass === 1) {
        const curOn = powered && v.start + i === v.cursor && blinkOn, under = at & UNDER;
        for (let c = 0; c < 5; c++) { g.fillStyle = curOn || under ? onC : offC; g.fillRect(cx + c * P, y0 + 7.4 * P, D, D * .7); }
      }
    }
  }
  lcdTex.needsUpdate = true;
}

// ---------------------------------------------------------------- camera
const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
// Four snap views, one scroll gesture per step: the paper · typing · the desk · desk overview.
let view = 1, glanceTimer = 0, glanced = false;
const VIEW_NAMES = ['paper', 'typing', 'desk', 'all scraps'];
const P_TYPE = { pos: new THREE.Vector3(0, 4.1, 10.2), tgt: new THREE.Vector3(0, -.3, .3) };
const P_DESK = { pos: new THREE.Vector3(-3.2, 8.4, 15.4), tgt: new THREE.Vector3(-4.4, DESK_Y, 7.6) };
const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3(), sPos = new THREE.Vector3(0, 4.1, 10.2), sTgt = new THREE.Vector3(0, -.15, 0);
const vPos = new THREE.Vector3(), vTgt = new THREE.Vector3();
const deskPan = new THREE.Vector3();
const coarse = navigator.maxTouchPoints > 0 && matchMedia('(any-pointer: coarse)').matches;   // a touch device (tablet), even with a keyboard attached
let parS = coarse ? 0 : 1;
function setView(v, fromGlance = false) {
  v = clamp(v, 0, 3); glanced = fromGlance; clearTimeout(glanceTimer);
  if (v === view) return; if (v === 3 || v < 2) deskPan.set(0, 0, 0); if (v === 3) overviewBox = null; view = v; updateViewDots(); updateTools();
}
// After a tear the camera glances at the desk so you see the sheet land, then returns to the machine.
// The moment you do anything on the desk (click, drag, pan, draw, use the toolbar), the glance becomes a
// real visit and the camera stays: it must never pull you away mid-task.
function glance() {
  if (view !== 1) return;
  setView(2, true);
  glanceTimer = setTimeout(() => {
    if (glanced && view === 2 && !inspecting && !drag && !pan && !stroke && !confirmOpen) setView(1);
    else settleGlance();
  }, 2900);
}
function settleGlance() { if (!glanced) return; glanced = false; clearTimeout(glanceTimer); updateTools(); }
function fitWidth(pos, tgt, halfW) {
  const dir = pos.clone().sub(tgt), need = halfW / (Math.tan(deg(camera.fov / 2)) * camera.aspect);
  if (dir.length() < need) pos.copy(tgt).addScaledVector(dir, need / dir.length());
}
function viewPose(v, pos, tgt) {
  if (v === 0) {
    sample(Math.max(1.2, Math.min(sheet.feed, 12) * .55));
    tgt.set(0, PT.y, PT.z); pos.set(0, PT.y + .8, PT.z + 8.5); fitWidth(pos, tgt, 5.4);
  } else if (v === 1) {
    pos.copy(P_TYPE.pos); tgt.copy(P_TYPE.tgt); fitWidth(pos, tgt, 6.3);
  } else if (v === 2) {
    pos.copy(P_DESK.pos).add(deskPan); tgt.copy(P_DESK.tgt).add(deskPan); fitWidth(pos, tgt, 5.5);
  } else {
    // overview: frame every scrap on the desk, looking down steeply
    let x0 = Math.min(-9.5, BASKET.x - BASKET.r), x1 = -.5, z0 = Math.min(4.6, BASKET.z - BASKET.r), z1 = 8.6;
    for (const s of scraps) {
      const a = s.deskTarget || s.pos;
      for (let i = 0; i < a.length; i += 30) { x0 = Math.min(x0, a[i]); x1 = Math.max(x1, a[i]); z0 = Math.min(z0, a[i + 2]); z1 = Math.max(z1, a[i + 2]); }
    }
    // hold the framing steady: fit once on arrival, then only widen if something would fall out of frame
    const b = overviewBox;
    if (!b) overviewBox = [x0, x1, z0, z1];
    else if (x0 < b[0] || x1 > b[1] || z0 < b[2] || z1 > b[3]) overviewBox = [Math.min(x0, b[0]), Math.max(x1, b[1]), Math.min(z0, b[2]), Math.max(z1, b[3])];
    overviewPose(...overviewBox, pos, tgt);
  }
  if (v === 3) { pos.add(deskPan); tgt.add(deskPan); }
}
let overviewBox = null;
function overviewPose(x0, x1, z0, z1, pos, tgt) {
  {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hw = (x1 - x0) / 2 + 1.2, hd = (z1 - z0) / 2 + 1.2;
    const pitch = deg(62), tanV = Math.tan(deg(camera.fov / 2));
    const d = Math.max(hd * Math.sin(pitch) / tanV + hd * Math.cos(pitch), hw / (tanV * camera.aspect)) * 1.08;
    tgt.set(cx, DESK_Y, cz + hd * .08); pos.set(cx, DESK_Y + Math.sin(pitch) * d, tgt.z + Math.cos(pitch) * d);
  }
}
function updateCamera(dt) {
  viewPose(view, vPos, vTgt);
  const k = 1 - Math.exp(-dt * 3.4);
  sPos.lerp(vPos, k); sTgt.lerp(vTgt, k);
  // thinner haze when looking across the desk from further away
  const fogWant = view === 3 ? .009 : view === 2 ? .018 : .03; scene.fog.density += (fogWant - scene.fog.density) * k;
  camPos.copy(sPos); camTgt.copy(sTgt);
  if (!inspecting) { mouse.sx += (mouse.x - mouse.sx) * (1 - Math.exp(-dt * 2.5)); mouse.sy += (mouse.y - mouse.sy) * (1 - Math.exp(-dt * 2.5)); }
  // mouse parallax only while typing or reading the paper; on the desk the camera must hold still so
  // whatever you drag stays under the cursor. Eased, so switching views doesn't jolt.
  parS += ((view >= 2 || drag || pan || coarse ? 0 : 1) - parS) * (1 - Math.exp(-dt * 4));
  const par = parS;
  camPos.x += mouse.sx * .45 * par; camPos.y -= mouse.sy * .25 * par;
  const moved = camera.position.distanceToSquared(camPos) > 1e-9 || lastTgt.distanceToSquared(camTgt) > 1e-9;
  camera.position.copy(camPos); camera.lookAt(camTgt); lastTgt.copy(camTgt);
  return moved;
}
const lastTgt = new THREE.Vector3();
const viewDots = document.getElementById('views');
function updateViewDots() {
  viewDots.innerHTML = VIEW_NAMES.map((n, i) => `<div class="${i === view ? 'on' : ''}" data-v="${i}" role="button" aria-label="${n} view"><span>${n}</span><i></i></div>`).join('');
}
viewDots.addEventListener('click', ev => { const d = ev.target.closest('[data-v]'); if (d && powered && !inspecting) setView(+d.dataset.v); });
updateViewDots();

// ---------------------------------------------------------------- persistence
// Saved to IndexedDB: 'meta' holds the machine and the order of things on the desk, and each scrap is
// its own record, written only when it changes. The old localStorage save is imported once.
const LEGACY_KEY = 'platen.v1';
let saveTimer = 0, saving = false, saveAgain = false, muted = false;
// canSave is off when the saved desk couldn't be read (so a blank desk never overwrites it) or when
// another tab holds the desk; keptIds are records we couldn't restore, kept rather than orphaned
let canSave = true, saveWarned = false;
const removedIds = new Set(), doomed = new Set(), kept = { order: [], trash: [] };
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }
// One tab owns the desk. A second tab still works, but doesn't save, so two copies can't overwrite
// each other's work. (Browsers without Web Locks just save as before.)
function claimDesk() {
  if (!navigator.locks?.request) return Promise.resolve(true);
  return new Promise(res => {
    navigator.locks.request('platen-desk', { ifAvailable: true }, lock => { if (!lock) { res(false); return; } res(true); return new Promise(() => { }); })
      .catch(() => res(true));
  });
}
async function save() {
  if (!canSave || !sheet) return;
  if (saving) { saveAgain = true; return; }   // run again as soon as this one lands (a timer may never fire on close)
  saving = true;
  const live = a => a.filter(s => !doomed.has(s));
  const dirty = [...live(scraps), ...live(trash)].filter(s => s.dirty), dels = [...removedIds];
  try {
    const meta = {
      v: 2, mode, muted, ctl: { paper: ctl.paper, spacing: ctl.spacing, wi: ctl.wi },
      sheet: { ops: packOps(sheet.ops), feed: sheet.feed, topJag: sheet.topJag, P: sheet.P, seed: sheet.seed },
      chars: { charCol, lineStartCol, buf, bufA: bufA.slice(0, buf.length) },
      order: [...live(scraps).map(s => s.id), ...kept.order], trash: [...live(trash).map(s => s.id), ...kept.trash],
    };
    const puts = [['meta', meta]];
    for (const s of dirty) { puts.push(['scrap:' + s.id, s.serialize()]); s.dirty = false; }
    await store.write(puts, dels.map(id => 'scrap:' + id));
    for (const id of dels) removedIds.delete(id);   // only forget what's actually gone
    saveWarned = false;
  } catch (e) {
    for (const s of dirty) s.dirty = true;          // try these again next time
    console.warn('save failed', e);
    if (!saveWarned) { saveWarned = true; toast('couldn’t save: your browser refused the write'); }
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; save(); }
  }
}
// never lose the last few moves: write immediately when the tab is hidden or closed
addEventListener('pagehide', () => { clearTimeout(saveTimer); save(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(saveTimer); save(); } });
async function load() {
  let all;
  try { all = await store.readAll(); }
  catch (e) {
    // the desk exists but couldn't be read (or storage is off): run without saving rather than risk
    // writing an empty desk over a full one
    console.warn('IndexedDB unavailable', e);
    canSave = false; return { failed: true };
  }
  if (all.has('meta')) {
    const meta = all.get('meta'), get = id => all.get('scrap:' + id);
    return { meta, scraps: (meta.order || []).map(id => [id, get(id)]), trash: (meta.trash || []).map(id => [id, get(id)]) };
  }
  try {   // one-time import of the v1 localStorage save
    const v1 = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
    if (v1 && v1.sheet) return { meta: { mode: v1.mode, ctl: v1.ctl, sheet: v1.sheet }, scraps: v1.scraps || [], trash: [], legacy: true };
  } catch (e) { }
  return null;
}

// ---------------------------------------------------------------- UI
const toastEl = document.getElementById('toast'); let toastT = 0;
function toast(m) { toastEl.textContent = m; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), 1800); }
const helpEl = document.getElementById('help');
const HELP_TYPE = '';
const HELP_OLD = '<span><kbd>⏎</kbd>print line</span><span><kbd>⌃M</kbd>line / char mode</span><span><kbd>⌫</kbd>edit · correct</span><span><kbd>PgUp</kbd><kbd>PgDn</kbd>turn platen</span><span><kbd>⌃X</kbd>tear off</span><span><kbd>scroll</kbd>paper · typing · desk · all scraps</span><span><kbd>drag</kbd>move a scrap (scroll to turn it)</span><span><kbd>click</kbd>pick it up</span>';
const HELP_INSPECT = '<span><kbd>scroll</kbd>read along</span><span><kbd>C</kbd>copy text</span><span><kbd>S</kbd>save PNG</span><span><kbd>esc</kbd> / <kbd>click</kbd>put it down</span>';
function setHelp(html) { helpEl.innerHTML = html; helpEl.classList.toggle('on', !!html); }

function inspect(s) {
  inspecting = s; s.state = 'flying'; s.pan = 0; s.panS = 0; mouse.x = mouse.y = 0;
  heldScene.add(s.mesh); s.shadow.visible = false;   // held up to the eye: drawn in its own pass
  s.ensureFull();
  Sound.rustle();
  s.flyTo(s.inspectVerts(0), .85, .7, () => { s.state = 'inspect'; });
  setHelp(`<span>${s.P.type === 'card' ? 'typed' : 'torn off'} ${whenText(s.created)}</span>` + HELP_INSPECT); actionsEl.classList.add('on'); updateTools();
}
function putDown() {
  const s = inspecting; if (!s) return; inspecting = null; s.state = 'flying';
  Sound.rustle();
  s.flyTo(s.deskTarget, .85, .5, () => { s.state = 'desk'; scene.add(s.mesh); s.releaseFull(); Sound.flop(.22); });
  setHelp(HELP_TYPE); actionsEl.classList.remove('on'); updateTools();
}
function whenText(t) {
  const d = new Date(t), now = new Date(), days = Math.floor((now.setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 864e5);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return days === 0 ? `today, ${hm}` : days === 1 ? `yesterday, ${hm}` : days < 7 ? `${d.toLocaleDateString([], { weekday: 'long' })}, ${hm}` : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
function copyScrap() {
  if (!inspecting) return;
  const t = opsToText(inspecting.ops);
  navigator.clipboard?.writeText(t).then(() => toast('text copied'), () => toast('copy failed'));
}
// transparent PNG: the torn top and bottom edges (and fanfold sprocket holes) are cut out at full resolution
function saveScrapImage() {
  const s = inspecting; if (!s) return;
  s.ensureFull();
  const c = mkCanvas(s.fullMap.width, s.fullMap.height), g = c.getContext('2d');
  const m = mkCanvas(c.width, c.height); drawAlpha(m, s.len, s.topJag, s.botJag, s.P);
  const mg = m.getContext('2d'), id = mg.getImageData(0, 0, m.width, m.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 0; }
  mg.putImageData(id, 0, 0);
  g.drawImage(s.fullMap, 0, 0); g.globalCompositeOperation = 'destination-in'; g.drawImage(m, 0, 0);
  const words = opsToText(s.ops).trim().split(/\s+/).slice(0, 4).join('-').replace(/[^a-z0-9-]/gi, '').toLowerCase();
  c.toBlob(b => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `platen-${words || 'scrap'}.png`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast('PNG saved');
  }, 'image/png');
}
const actionsEl = document.getElementById('actions');
actionsEl.addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b || !inspecting) return; ev.stopPropagation(); b.blur(); const a = b.dataset.act; a === 'png' ? saveScrapImage() : a === 'bin' ? throwAwayHeld() : copyScrap(); });
// hidden means hidden: out of the tab order and unclickable
new MutationObserver(() => { actionsEl.inert = !actionsEl.classList.contains('on'); }).observe(actionsEl, { attributes: true, attributeFilter: ['class'] });
actionsEl.inert = true;

const raycaster = new THREE.Raycaster(); const ndc = new THREE.Vector2();
function toNdc(ev) { const r = canvas.getBoundingClientRect(); ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); return ndc; }
function scrapAt(ev) {
  raycaster.setFromCamera(toNdc(ev), camera);
  const hits = raycaster.intersectObjects([...scraps.filter(s => s.state === 'desk'), ...trash.filter(s => !s.flight)].map(s => s.mesh), false);
  return hits.length ? hits[0].object.userData.scrap : null;
}
let hovered = null, press = null, drag = null;
const deskPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitP = new THREE.Vector3();
function planeHit(ev, y, cam = camera) {
  raycaster.setFromCamera(toNdc(ev), cam); deskPlane.constant = -y;
  return raycaster.ray.intersectPlane(deskPlane, hitP) ? hitP : null;
}
function startDrag(s, ev) {
  press = null;
  if (hovered) hovered.mat.emissiveIntensity = 0; hovered = null;
  scraps.splice(scraps.indexOf(s), 1); scraps.push(s);      // picked-up paper goes on top of the pile
  const box = s.bbox || footBox(s);
  rebuildDesk(true, s, box);                                  // whatever was on top of it falls back down
  const top = hfTop();
  let my = 0; for (let i = 1; i < s.pos.length; i += 3) my += s.pos[i]; my /= s.count;
  // the sheet lifts to a fixed height; the pointer is tracked on that same plane so it stays under your cursor
  const y0 = top + .38, p = planeHit(ev, y0) || new THREE.Vector3(s.desk.x, y0, s.desk.z);
  drag = { pid: ev.pointerId, s, y: y0, y0, ox: s.desk.x - p.x, oz: s.desk.z - p.z, tx: s.desk.x, tz: s.desk.z, tyaw: s.desk.yaw, py: y0, box, overBin: false };
  s.state = 'drag'; s.flight = null; s.shadow.visible = false;
  canvas.style.cursor = 'grabbing'; Sound.rustle();
}
function endDrag() {
  const s = drag.s, overBin = drag.overBin, before = drag.box, dragYaw = drag.tyaw; drag = null;
  basketRim.emissiveIntensity = 0; canvas.style.cursor = '';
  if (overBin) { s.state = 'desk'; trashScrap(s); return; }
  s.desk.x = drag_tx_last.x; s.desk.z = drag_tx_last.z; s.desk.yaw = dragYaw;
  clampDesk(s.desk, s.effLen(), s.P.w);
  s.state = 'desk'; s.dirty = true;
  rebuildDesk(true, null, boxJoin(before, footBox(s)));
  setTimeout(() => Sound.flop(.24), 250);
  scheduleSave();
}
let pan = null;
// ---------------------------------------------------------------- desk tools: move / marker
let tool = 'move', stroke = null;
const markUndo = [];
const markerActive = () => tool === 'mark' && powered && (inspecting ? inspecting.state === 'inspect' : view >= 2);
// exact point on the paper surface under the pointer, in paper inches
function paperPointAt(ev, only = null) {
  raycaster.setFromCamera(toNdc(ev), camera);
  const meshes = only ? [only.mesh] : inspecting ? [inspecting.mesh] : scraps.filter(s => s.state === 'desk' && !s.flight).map(s => s.mesh);
  const h = raycaster.intersectObjects(meshes, false)[0];
  if (!h || !h.uv) return null;
  const s = h.object.userData.scrap;
  return { s, x: h.uv.x * s.P.w, y: (1 - h.uv.y) * s.len };
}
function markMove(ev) {
  const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
  for (const e of (evs.length ? evs : [ev])) {
    const p = paperPointAt(e, stroke.s);
    if (!p) { stroke.pts = null; continue; }                    // slid off the sheet: lift the pen
    if (!stroke.pts) { stroke.pts = [p.x, p.y]; stroke.s.marks.push(stroke.pts); stroke.count++; continue; }
    const n = stroke.pts.length;
    if (Math.hypot(p.x - stroke.pts[n - 2], p.y - stroke.pts[n - 1]) < .012) continue;
    stroke.pts.push(p.x, p.y);
  }
  if (stroke.pts) stroke.s.drawLiveStroke(stroke.pts);
}
const toolsEl = document.getElementById('tools');
function setTool(t) {
  if (t === tool) return; tool = t; Sound.knob();
  for (const b of toolsEl.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  updateTools();
}
function updateTools() {
  toolsEl.classList.toggle('on', powered && (view >= 2 || !!inspecting));
  toolsEl.classList.toggle('top', !!inspecting);   // reading a sheet: the pill moves to the top, clear of the text and the hints canvas.classList.toggle('marking', tool === 'mark' && (view >= 2 || !!inspecting));
  const empty = toolsEl.querySelector('[data-act="empty"]'), clear = toolsEl.querySelector('[data-act="clear"]');
  if (empty) empty.disabled = !trash.length;
  if (clear) clear.disabled = !(scraps.length + trash.length);
  updateTouchbar();
}
toolsEl.addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b || b.disabled) return; ev.stopPropagation(); b.blur();
  settleGlance();
  if (b.dataset.act === 'empty') emptyBin(); else if (b.dataset.act === 'clear') clearDesk(); else setTool(b.dataset.tool);
});
function undoMark() {
  const s = markUndo.pop(); if (!s || !s.marks.length) return false;
  s.marks.pop(); s.dirty = true; s.redrawMarksLow(); scheduleSave(); return true;
}
const drag_tx_last = { x: 0, z: 0 };
addEventListener('pointermove', ev => {
  mouse.x = ev.clientX / innerWidth * 2 - 1; mouse.y = ev.clientY / innerHeight * 2 - 1;
  if (touches.has(ev.pointerId)) touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (stroke) { markMove(ev); return; }
  if (held && inspecting) {
    // swipe the held sheet to read along it; a tap (no movement) puts it down
    const dx = ev.clientX - held.x, dy = ev.clientY - held.y;
    if (Math.hypot(dx, dy) > 6) held.moved = true;
    if (held.moved && inspecting.state === 'inspect') { const k = 2 * inspecting.holdDist() * Math.tan(deg(camera.fov / 2)) / innerHeight; inspecting.pan = clamp(held.pan0 - dy * k, 0, inspecting.maxPan()); }
    return;
  }
  if (!powered || inspecting) return;
  if (drag && touches.size >= 2) {
    const [a, b] = [...touches.values()], ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (!drag.twist) drag.twist = { ang, yaw: drag.tyaw };
    let d = ang - drag.twist.ang; d = Math.atan2(Math.sin(d), Math.cos(d));
    drag.tyaw = drag.twist.yaw - d;
    if (ev.pointerId !== drag.pid) return;
  }
  if (press && !drag && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 6) startDrag(press.s, ev);
  if (drag) {
    const p = planeHit(ev, drag.py);
    if (p) {
      // pointer over the bin's opening?
      const q = planeHit(ev, DESK_Y + BASKET.h);
      drag.overBin = !!q && Math.hypot(q.x - BASKET.x, q.z - BASKET.z) < BASKET.r + .3;
      basketRim.emissiveIntensity = drag.overBin ? .35 : 0;
      const d = { x: p.x + drag.ox, z: p.z + drag.oz, yaw: drag.tyaw };
      if (!drag.overBin) clampDesk(d, drag.s.effLen(), drag.s.P.w);
      drag.tx = d.x; drag.tz = d.z; drag_tx_last.x = d.x; drag_tx_last.z = d.z;
    }
    return;
  }
  if (pan) {
    // grab-and-drag: the desk point you pressed stays under the pointer
    const q = planeHit(ev, DESK_Y, pan.cam);
    if (q) { deskPan.x = pan.x0 + (pan.p.x - q.x); deskPan.z = pan.z0 + (pan.p.z - q.z); }
    return;
  }
  const c = controlAt(ev);
  if (markerActive() && !c) {
    if (hovered) { hovered.mat.emissiveIntensity = 0; hovered = null; }
    canvas.style.cursor = paperPointAt(ev) ? '' : 'grab';        // the marker cursor comes from CSS (.marking)
    return;
  }
  const s = c ? null : scrapAt(ev);
  if (s !== hovered) { if (hovered) hovered.mat.emissiveIntensity = 0; hovered = s; if (s) s.mat.emissiveIntensity = .05; }
  canvas.style.cursor = c ? 'pointer' : s ? (s.state === 'trash' ? 'pointer' : 'grab') : view >= 2 ? 'grab' : '';
});
function controlAt(ev) {
  raycaster.setFromCamera(toNdc(ev), camera);
  const h = raycaster.intersectObjects(controls, false);
  return h.length ? h[0].object.userData.control : null;
}
let held = null;
const touches = new Map();
canvas.addEventListener('pointerdown', ev => {
  if (!powered) return;
  settleGlance();
  touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (drag) { if (touches.size === 2) drag.twist = null; return; }   // second finger: twist the sheet being dragged
  if (inspecting) {
    if (markerActive()) {
      const p = paperPointAt(ev);
      if (p) { stroke = { s: p.s, pts: [p.x, p.y], count: 1 }; p.s.marks.push(stroke.pts); p.s.drawLiveStroke(stroke.pts); canvas.setPointerCapture?.(ev.pointerId); return; }
    }
    held = { x: ev.clientX, y: ev.clientY, pan0: inspecting.pan, moved: false }; canvas.setPointerCapture?.(ev.pointerId); return;
  }
  if (coarse && view <= 1) focusKeyboard();
  const c = controlAt(ev); if (c) { useControl(c); return; }
  if (ev.button === 2) return;
  if (markerActive()) {
    const p = paperPointAt(ev);
    if (p) {
      p.s.ensureMarkLayers();
      stroke = { s: p.s, pts: [p.x, p.y], count: 1 }; p.s.marks.push(stroke.pts);
      p.s.drawLiveStroke(stroke.pts); canvas.setPointerCapture?.(ev.pointerId); return;
    }
  }
  const s = scrapAt(ev);
  if (s && s.state === 'trash') { restoreFromTrash(s); return; }
  if (s) { press = { s, x: ev.clientX, y: ev.clientY, pid: ev.pointerId }; drag_tx_last.x = s.desk.x; drag_tx_last.z = s.desk.z; canvas.setPointerCapture?.(ev.pointerId); return; }
  if (view >= 2) {
    const cam = camera.clone(), p = planeHit(ev, DESK_Y, cam);
    if (p) { pan = { cam, p: p.clone(), x0: deskPan.x, z0: deskPan.z }; canvas.style.cursor = 'grabbing'; canvas.setPointerCapture?.(ev.pointerId); }
  }
});
canvas.addEventListener('contextmenu', ev => {
  ev.preventDefault(); if (!powered || inspecting) return;
});
// A gesture that ends without a pointerup (an iOS system gesture, an alert, the mouse released in
// another window) finishes exactly as if it had been released, so nothing stays stuck to the pointer.
function endGestures() {
  if (stroke) { const s = stroke.s; for (let i = 0; i < stroke.count; i++) markUndo.push(s); s.dirty = true; stroke = null; scheduleSave(); }
  if (drag) endDrag();
  if (pan) { pan = null; canvas.style.cursor = view >= 2 ? 'grab' : ''; }
  if (press) { press = null; if (hovered) hovered.mat.emissiveIntensity = 0; hovered = null; canvas.style.cursor = ''; }
  held = null; touches.clear();
}
addEventListener('pointercancel', () => endGestures());
canvas.addEventListener('lostpointercapture', ev => { if (ev.buttons === 0 && (drag || pan || stroke)) endGestures(); });
addEventListener('blur', () => endGestures());
addEventListener('pointerup', ev => {
  try { if (canvas.hasPointerCapture?.(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId); } catch (e) { }
  touches.delete(ev.pointerId);
  if (drag && ev.pointerId !== drag.pid) { drag.twist = null; return; }
  if (held) { const tap = !held.moved; held = null; if (tap && !stroke) putDown(); return; }
  if (stroke) {
    const s = stroke.s; for (let i = 0; i < stroke.count; i++) markUndo.push(s);
    s.dirty = true; stroke = null; scheduleSave(); return;
  }
  if (pan) { pan = null; canvas.style.cursor = view >= 2 ? 'grab' : ''; return; }
  if (drag) { endDrag(); return; }
  if (press) { const s = press.s; press = null; if (hovered) hovered.mat.emissiveIntensity = 0; hovered = null; canvas.style.cursor = ''; inspect(s); }
});
let wheelAcc = 0, wheelLock = 0, wheelLast = 0;
addEventListener('wheel', ev => {
  if (!powered) return; ev.preventDefault();
  if (confirmOpen || infoEl.open) return;
  if (drag) { drag.tyaw -= ev.deltaY * .003; return; }
  if (inspecting) { if (inspecting.state === 'inspect') inspecting.pan = clamp(inspecting.pan + ev.deltaY * .006, 0, inspecting.maxPan()); return; }
  // one snap per gesture: accumulate, step, then hold until the gesture's inertia dies down
  if (NOW - wheelLast > .25) wheelAcc = 0;
  wheelLast = NOW;
  if (NOW < wheelLock) { if (Math.abs(ev.deltaY) > 2) wheelLock = Math.max(wheelLock, NOW + .14); return; }
  wheelAcc += ev.deltaY;
  if (Math.abs(wheelAcc) > 30) { setView(view + Math.sign(wheelAcc)); wheelAcc = 0; wheelLock = NOW + .5; }
}, { passive: false });

function onKey(e) {
  if (confirmOpen || infoEl.open) return;
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !inspecting && powered && view >= 2 && !glanced) { e.preventDefault(); openInfo(); return; }   // on the desk only: at the machine, ? is a character
  if (e.isComposing || e.key === 'Dead' || e.key === 'Unidentified') return;
  caps = e.getModifierState?.('CapsLock') ?? caps; lcdDirty = true;
  if (!powered) {
    // a real key switches it on; modifiers alone (Alt-Tab, Ctrl-Tab) and function keys (F5) don't
    const switchKey = e.key.length === 1 || e.key === 'Enter';
    if (switchKey && !e.metaKey && !e.ctrlKey && ready && !document.activeElement?.closest?.('a')) { e.preventDefault(); powerOn(); }
    return;
  }
  // mid-gesture (dragging a sheet, panning, drawing) the keyboard waits
  if ((drag || pan || stroke) && e.key !== 'Escape') return;
  // AltGr (Ctrl+Alt on Windows layouts) types characters like @ [ ] { } ł: treat them as plain typing
  if (e.getModifierState?.('AltGraph') && e.key.length === 1) { const oe = e; e = { key: oe.key, code: oe.code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: oe.shiftKey, repeat: oe.repeat, isComposing: false, target: oe.target, preventDefault: () => oe.preventDefault(), getModifierState: m => oe.getModifierState(m) }; }
  Sound.resume();
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  // desk shortcuts only when you chose the desk (not during the brief glance after a tear, while you're still typing)
  const atDesk = (view >= 2 && !glanced) || inspecting;
  if (plain && atDesk && (e.key === 'v' || e.key === 'V' || e.key === 'm' || e.key === 'M')) { e.preventDefault(); setTool(e.key.toLowerCase() === 'v' ? 'move' : 'mark'); return; }
  if (inspecting) {
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); if (!undoMark()) Sound.error(); return; }
    if (e.key === 'Escape') putDown();
    else if (e.key === 'Delete' || e.key === 'Backspace') throwAwayHeld();
    else if (k === 'c' && !e.metaKey && !e.ctrlKey) copyScrap();
    else if (k === 's' && !e.metaKey && !e.ctrlKey) saveScrapImage();
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') inspecting.pan = clamp(inspecting.pan + (e.key === 'PageDown' ? 3 : .6), 0, inspecting.maxPan());
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') inspecting.pan = clamp(inspecting.pan - (e.key === 'PageUp' ? 3 : .6), 0, inspecting.maxPan());
    else return;
    e.preventDefault(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && view >= 2) { e.preventDefault(); if (!undoMark()) Sound.error(); return; }
  if (e.metaKey) return;
  const k = e.key;
  if (e.altKey && !e.ctrlKey) {
    const c = { KeyP: 'paper', KeyW: 'width', KeyS: 'spacing' }[e.code];
    if (c) { e.preventDefault(); useControl(c); return; }
    if (e.code === 'KeyT') { e.preventDefault(); tidyDesk(); return; }
    if (e.code === 'KeyM') { e.preventDefault(); setMuted(!muted); return; }
  }
  if (e.ctrlKey) {
    // by letter, or by key position on layouts whose letters aren't Latin (Cyrillic, Greek)
    let lk = k.toLowerCase(); if (!/^[a-z]$/.test(lk) && /^Key[A-Z]$/.test(e.code || '')) lk = e.code.slice(3).toLowerCase();
    if (e.repeat && lk === 'x') { e.preventDefault(); return; }
    if (lk === 'x') requestTear();
    else if (lk === 'm') toggleMode();
    else if (lk === 'b') toggleStyle(BOLD);
    else if (lk === 'u') toggleStyle(UNDER);
    else if (k === 'ArrowUp') knob(-1);
    else if (k === 'ArrowDown') knob(1);
    else return;
    e.preventDefault(); return;
  }
  if (k === 'PageUp' || k === 'PageDown') { e.preventDefault(); knob(k === 'PageUp' ? -1 : 1); return; }
  if (k === 'Escape') { setView(1); return; }
  if ((k === 'Delete' || k === 'Backspace') && view >= 2 && !glanced && hovered && hovered.state === 'desk' && !hovered.flight) { e.preventDefault(); trashScrap(hovered); hovered = null; return; }
  if (k === ' ' || k === 'Tab' || k === 'Backspace' || k.startsWith('Arrow')) e.preventDefault();
  if (view !== 1 && (printable(e) || k === 'Enter')) setView(1);
  if (mode === 'line') lineKey(e); else charKey(e);
}
addEventListener('keydown', onKey);
// the keyboard itself: every physical key press and release is voiced
addEventListener('keydown', e => { if (powered && !confirmOpen && !infoEl.open && !e.isComposing && e.key !== 'Unidentified') Sound.keyDown(e.code, e.repeat); }, true);
addEventListener('keyup', e => { if (powered) Sound.keyUp(e.code); }, true);

// ---------------------------------------------------------------- tablets: on-screen keyboard and touch bar
// A hidden textarea summons the soft keyboard. Real keys still arrive as keydown (and are kept out of the
// textarea); soft keyboards that only report text are read from input events, with a sentinel character so
// Backspace is detectable even when there's nothing to delete.
const kbd = document.getElementById('kbd'), SENT = '\u200b';
const fakeKey = key => ({ key, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, target: kbd, preventDefault() { }, getModifierState() { return false; } });
function resetKbd() { kbd.value = SENT; try { kbd.setSelectionRange(1, 1); } catch (e) { } }
function focusKeyboard() { resetKbd(); kbd.focus({ preventScroll: true }); }
kbd.addEventListener('keydown', e => { if (e.key !== 'Unidentified' && !e.isComposing && (e.key.length === 1 || /^(Enter|Backspace|Tab|Delete|Arrow)/.test(e.key))) e.preventDefault(); });
kbd.addEventListener('beforeinput', e => {
  if (e.inputType === 'deleteContentBackward') { e.preventDefault(); onKey(fakeKey('Backspace')); }
  else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); onKey(fakeKey('Enter')); }
});
// on-screen keyboards that compose (predictive text, accents, CJK) deliver the finished text at the end
let kbdComposing = false;
kbd.addEventListener('compositionstart', () => { kbdComposing = true; });
kbd.addEventListener('compositionend', () => { kbdComposing = false; kbd.dispatchEvent(new Event('input')); });
kbd.addEventListener('input', ev => {
  if (kbdComposing || ev.isComposing || confirmOpen) return;
  const v = kbd.value;
  if (!v.startsWith(SENT)) onKey(fakeKey('Backspace'));
  for (const ch of v.replace(SENT, '')) {
    const code = ch === ' ' ? 'Space' : ch === '\n' ? 'Enter' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : 'KeyG';
    Sound.keyDown(code); setTimeout(() => Sound.keyUp(code), 80);
    onKey(fakeKey(ch === '\n' ? 'Enter' : ch));
  }
  resetKbd();
});
// keep the display in sight above the soft keyboard: shift the picture up by the covered height
function keyboardOffset() {
  const vv = window.visualViewport; if (!vv) return;
  const hidden = innerHeight - vv.height - vv.offsetTop;
  if (hidden > 80 && document.activeElement === kbd) camera.setViewOffset(innerWidth, innerHeight, 0, hidden * .82, innerWidth, innerHeight);
  else camera.clearViewOffset();
  invalidate();
}
window.visualViewport?.addEventListener('resize', keyboardOffset);
kbd.addEventListener('focus', () => setTimeout(keyboardOffset, 300));
kbd.addEventListener('blur', keyboardOffset);
const touchbar = document.getElementById('touchbar');
function updateTouchbar() {
  if (!touchbar) return;
  touchbar.classList.toggle('on', coarse && powered && view <= 1 && !inspecting);
  const set = (a, on) => touchbar.querySelector(`[data-act="${a}"]`)?.setAttribute('aria-pressed', String(on));
  set('bold', !!(style & BOLD)); set('under', !!(style & UNDER)); set('mode', mode === 'char');
}
touchbar?.addEventListener('pointerdown', ev => ev.preventDefault());   // don't steal focus from the keyboard
touchbar?.addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return; Sound.resume();
  const a = b.dataset.act;
  if (a === 'kbd') { document.activeElement === kbd ? kbd.blur() : focusKeyboard(); }
  else if (a === 'tear') requestTear();
  else if (a === 'bold') toggleStyle(BOLD);
  else if (a === 'under') toggleStyle(UNDER);
  else if (a === 'mode') toggleMode();
  updateTouchbar();
});

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
dispatchEvent(new Event('resize'));

// film grain overlay
{
  const c = mkCanvas(160, 160), g = c.getContext('2d'), id = g.createImageData(160, 160);
  for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
  g.putImageData(id, 0, 0); document.getElementById('grain').style.backgroundImage = `url(${c.toDataURL()})`;
}

// ---------------------------------------------------------------- boot
let ready = false, restoredSheet = false;
// ---------------------------------------------------------------- sound switch
const muteBtn = document.getElementById('mute');
function setMuted(m, persist = true) {
  muted = m; Sound.setMuted(m);
  muteBtn.classList.toggle('off', m); muteBtn.setAttribute('aria-pressed', String(m)); muteBtn.title = m ? 'Sound off · Alt M' : 'Sound on · Alt M';
  if (persist) { toast(m ? 'sound off' : 'sound on'); scheduleSave(); }
}
muteBtn.addEventListener('click', ev => { ev.stopPropagation(); setMuted(!muted); muteBtn.blur(); });
// about: a short note, the quick uses, and links to how it works and the source
const infoEl = document.getElementById('info'), infoBtn = document.getElementById('infoBtn');
function openInfo() { if (infoEl.open || confirmOpen) return; endGestures?.(); infoEl.showModal(); }
infoBtn.addEventListener('click', ev => { ev.stopPropagation(); infoBtn.blur(); openInfo(); });
infoBtn.addEventListener('pointerdown', ev => ev.stopPropagation());
infoEl.addEventListener('click', ev => { if (ev.target === infoEl) infoEl.close(); });   // click outside the card closes it
infoEl.addEventListener('close', () => { if (powered) canvas.focus({ preventScroll: true }); });

// ---------------------------------------------------------------- time passing
// The room follows the real clock: daylight from a window behind you while the sun is up, a warm
// low glow at dawn and dusk, and at night only the lamp. Paper yellows slowly with age.
const NIGHT_BG = new THREE.Color(0x050403), DAY_BG = new THREE.Color(0x121416);
const DAY_SKY = new THREE.Color(0x8a97ad), NIGHT_SKY = new THREE.Color(0x1d2432), DUSK = new THREE.Color(0xffa060), NOON = new THREE.Color(0xbcd0ff);
function applyDaylight() {
  renderer.shadowMap.needsUpdate = true;
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
  const day = smooth(6, 8.5, h) * (1 - smooth(17.5, 20.5, h));
  const dusk = Math.min(1, Math.max(0, 1 - Math.abs(h - 19.2) / 1.4) + Math.max(0, 1 - Math.abs(h - 7) / 1.2));
  windowLight.intensity = .75 * day + .45 * dusk;
  windowLight.color.copy(NOON).lerp(DUSK, dusk / (day + dusk + 1e-3));
  hemi.intensity = .35 + .5 * day; hemi.color.copy(NIGHT_SKY).lerp(DAY_SKY, day);
  fill.intensity = .09 + .18 * day;
  lamp.intensity = 820 * (1 - .22 * day);
  scene.background.copy(NIGHT_BG).lerp(DAY_BG, day * .85); scene.fog.color.copy(scene.background);
  for (const s of [...scraps, ...trash]) s.ageTint();
  invalidate();
}
setInterval(applyDaylight, 60000);

// The paper is drawn with Courier Prime into a canvas. If a canvas draws before the face is usable it
// silently falls back to another font, and that text stays in the wrong face. document.fonts.load() can
// resolve before Safari's canvas can use the face, so we test what the canvas actually draws.
const TYPE_FONT = `${FONT_PX}px "Courier Prime"`;
let typeReady = false;
function typefaceDrawn() {
  const c = mkCanvas(90, 44), g = c.getContext('2d');
  const sig = f => { g.clearRect(0, 0, 90, 44); g.font = f; g.fillText('Mg&a', 2, 34); const d = g.getImageData(0, 0, 90, 44).data; let h = 0; for (let i = 3; i < d.length; i += 4) h = (h * 31 + d[i]) | 0; return h; };
  return sig(`${FONT_PX}px "Courier Prime", sans-serif`) !== sig(`${FONT_PX}px sans-serif`);
}
async function loadFonts() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try { await Promise.race([Promise.all([document.fonts.load(TYPE_FONT, 'Mg&a'), document.fonts.load(TYPE_FONT, 'ĀāŁłőŒ'), document.fonts.load('600 17px "IBM Plex Mono"')]), sleep(4000)]); } catch (e) { }
  for (let i = 0; i < 30 && !(typeReady = typefaceDrawn()); i++) await sleep(100);
  if (!typeReady) watchTypeface();
}
// the face arrived late: redraw everything that was drawn without it
function watchTypeface() {
  const check = () => {
    if (typeReady || !(typeReady = typefaceDrawn())) return;
    clearInterval(timer);
    if (sheet) sheet.repaint();
    for (const s of scraps) if (s.inked) { s.inked = false; if (!texQueue.includes(s)) texQueue.push(s); }
    invalidate();
  };
  const timer = setInterval(check, 400);
  document.fonts.addEventListener?.('loadingdone', check);
}
async function boot() {
  applyDaylight();
  await loadFonts();
  const saved = await load();
  if (saved?.failed) toast('your saved desk couldn’t be opened, so nothing will be saved this session');
  else if (!(await claimDesk())) { canSave = false; setTimeout(() => toast('Platen is open in another tab: this one won’t save'), 1500); }
  if (saved && !saved.failed) {
    const m = saved.meta;
    try {
      const SP = { ...DEFAULT_SPEC, ...(m.sheet?.P || {}) };
      const seed = m.sheet?.seed ?? randSeed(), feed = Number.isFinite(m.sheet?.feed) ? clamp(m.sheet.feed, .35, MAX_FEED) : .42;
      setSheet(new Sheet({ ops: unpackOps(m.sheet?.ops, seed), seed, feed, topJag: m.sheet?.topJag ?? null, P: SP }));
    } catch (e) { console.warn('sheet restore failed', e); setSheet(new Sheet({ feed: .42 })); }
    // the switches follow the paper actually loaded, not whatever was about to change when we last saved
    ctl.paper = Math.max(0, PAPER_TYPES.indexOf(sheet.P.type)); ctl.wi = sheet.P.type === 'card' ? clamp(m.ctl?.wi | 0, 0, 2) : Math.max(0, WIDTHS.findIndex(w => w.w === sheet.P.w));
    ctl.spacing = clamp(m.ctl?.spacing | 0, 0, 2);
    feedSpacing = ctl.spacing; ctl.paperS = ctl.paper; ctl.leverS = ctl.spacing; ctl.dialS = ctl.wi; ctl.guideW = sheet.P.w;
    const restore = (list, into, keep) => {
      for (const [id, d] of list) {
        try { if (!d) throw new Error('missing'); const sc = Scrap.restore(d); if (saved.legacy) sc.dirty = true; into.push(sc); }
        catch (e) { console.warn('scrap restore failed', id, e); if (d) keep.push(id); }   // keep the record; don't orphan it
      }
    };
    restore(saved.legacy ? saved.scraps.map(d => [d.id, d]) : saved.scraps, scraps, kept.order);
    restore(saved.trash, trash, kept.trash);
    rebuildDesk(false);
    placeTrash(false);
    mode = m.mode === 'char' ? 'char' : 'line';
    const c = m.chars || {}, cols = COLS_NOW();
    charCol = clamp(c.charCol | 0, 0, cols); lineStartCol = clamp(c.lineStartCol | 0, 0, cols);
    if (mode === 'line' && typeof c.buf === 'string') { buf = c.buf.slice(0, cols); bufA = (c.bufA || []).slice(0, buf.length); cur = buf.length; }
    setMuted(!!m.muted, false);
    restoredSheet = true;
    if (saved.legacy) scheduleSave();
  } else {
    setSheet(new Sheet({ feed: .42 }));
  }
  await warmUp();
  ready = true;
  const intro = document.getElementById('intro');
  intro.classList.remove('loading');
  document.getElementById('introMsg').textContent = coarse ? 'tap to switch it on' : 'press any key to switch it on';
  intro.addEventListener('pointerdown', ev => { if (ev.target.closest('a')) return; powerOn(); });
}
// Do the expensive first-frame work while the start screen still covers the room: compile every shader
// (in parallel where the browser allows), upload every texture, and draw a frame. Otherwise all of it
// lands on the first frames of the fade-in, which is what made switching on stutter on tablets.
async function warmUp() {
  const tick = () => new Promise(r => requestAnimationFrame(() => r()));
  try {
    updatePaperMesh(); updateCamera(1);
    // compileAsync can wait forever if the GPU context is lost mid-boot: never let it hold the start
    await Promise.race([renderer.compileAsync(scene, camera), new Promise(r => setTimeout(r, 2500))]);
  } catch (e) { }
  await tick();
  renderer.autoClear = false; renderer.clear(); renderer.render(scene, camera);
  await tick();
  // let the nearest scraps build their desk textures now, a few per frame, rather than during the fade
  const t0 = performance.now();
  while (texQueue.length && performance.now() - t0 < 700) { pumpTextures(10); await tick(); }
  renderer.clear(); renderer.render(scene, camera);
}
async function powerOn() {
  if (powered || !ready) return;
  powered = true;
  Sound.init(); Sound.resume();
  document.getElementById('intro').classList.add('gone');
  document.getElementById('curtain').classList.add('up');   // the room fades in as the machine wakes
  updateTools();
  canvas.focus();
  lcdDirty = true;
  Sound.beep(2080, .12, .045);
  lcdMessage('READY', 1.6);
  // power-on homing: the carriage runs out, finds its left stop, the head clicks once
  enqueue(async () => {
    await moveCarrier(12);
    await carriageReturn();
    await lockHead(true); await releaseHead(true);
    if (!restoredSheet) { Sound.lf(1.1, .6); await tweenProp(sheet, 'feed', 1.02, 1.1); }
    if (mode === 'char') await moveCarrier(charCol);
  });
  setTimeout(() => setHelp(HELP_TYPE), 1200);
}

// Upload only the patch of paper that changed. Re-uploading the whole 1275×3000 canvas every
// frame while the head burns text was the single biggest GPU/bus cost.
function uploadRegion(tex, ctx, r) {
  const p = renderer.properties.get(tex), H = ctx.canvas.height;
  if (!p.__webglTexture || p.__version !== tex.version || (r.x1 - r.x0) * (r.y1 - r.y0) > ctx.canvas.width * H * .25) { tex.needsUpdate = true; return; }
  const x = Math.max(0, r.x0 | 0), y = Math.max(0, r.y0 | 0), w = Math.min(ctx.canvas.width, Math.ceil(r.x1)) - x, h = Math.min(H, Math.ceil(r.y1)) - y;
  if (w <= 0 || h <= 0) return;
  const data = ctx.getImageData(x, y, w, h).data, gl = renderer.getContext();
  renderer.state.bindTexture(gl.TEXTURE_2D, p.__webglTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, tex.flipY);        // rows land bottom-up, like three's full upload
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x, tex.flipY ? H - y - h : y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  if (tex.generateMipmaps) { mipPending.add(tex); flushMips(); }
}
// Rebuilding the mip chain of a 1275×3000 texture every frame is costly on tablet GPUs. The fresh ink is
// already in the full-size level, which is what you see up close, so the smaller levels catch up ~20×/s.
const mipPending = new Set(); let mipT = 0;
function flushMips(force = false) {
  if (!mipPending.size || (!force && NOW - mipT < .05)) return;
  const gl = renderer.getContext(); mipT = NOW;
  for (const tex of mipPending) { const p = renderer.properties.get(tex); if (p.__webglTexture) { renderer.state.bindTexture(gl.TEXTURE_2D, p.__webglTexture); gl.generateMipmap(gl.TEXTURE_2D); } }
  mipPending.clear();
}
// Render on demand: the loop keeps ticking, but a frame is drawn only while something moves.
let wake = 3;
const invalidate = (n = 3) => { wake = Math.max(wake, n); };
addEventListener('resize', () => invalidate());
addEventListener('keydown', () => invalidate(), true);
addEventListener('pointerdown', () => invalidate(), true);
document.addEventListener('visibilitychange', () => invalidate());

// ---------------------------------------------------------------- loop
let lastT = performance.now(), blinkT = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(.05, (t - lastT) / 1000); lastT = t; NOW = performance.now() / 1000;
  let active = tweens.length > 0 || busy;
  updateTweens();

  // mechanism
  if (Math.abs(Mech.lockT - Mech.lock) > .002 || Mech.burn > .01) active = true;
  Mech.lock += (Mech.lockT - Mech.lock) * (1 - Math.exp(-dt * 28));
  carrier.position.x = Mech.x;
  Mech.burn *= Math.exp(-dt * 6);
  headDotsMat.color.setRGB(.35 + .65 * Mech.burn, .16 + .3 * Mech.burn, .09 + .06 * Mech.burn);
  headBlock.position.z = .07 * (1 - Mech.lock);             // retracted from the platen when released
  cassette.position.z = GUIDE_TOP.z + .025 * (1 - Mech.lock);
  reels[0].rotation.z = Mech.ribbon * 2.6; reels[1].rotation.z = Mech.ribbon * 3.8;
  let shadows = false;   // did anything that casts a shadow move?
  if (sheet) {
    platenRot.rotation.x = -sheet.feed / RP;
    if (updatePaperMesh()) active = shadows = true;
  }

  if (updateCamera(dt)) active = true;
  if (updateControls(dt)) active = shadows = true;
  if (pumpTextures(6)) active = true;
  for (const s of trash) if (s.update(dt)) active = shadows = true;
  { const want = inspecting ? 0 : view === 3 ? 520 : view === 2 ? 220 : 0, prev = roamLight.intensity;
    roamLight.intensity += (want - roamLight.intensity) * (1 - Math.exp(-dt * 3));
    roamLight.position.set(camTgt.x, DESK_Y + (view === 3 ? 20 : 13), camTgt.z + 3);
    if (Math.abs(roamLight.intensity - prev) > .05) active = true; }
  for (const s of scraps) {
    if (s.update(dt)) active = shadows = true;
    // a sheet lying on another casts no real shadow (the thin contact shadow covers it); only lifted sheets do
    const cast = s.state !== 'desk' || !!s.flight;
    if (s.mesh.castShadow !== cast) { s.mesh.castShadow = cast; shadows = true; }
  }
  if (shadows) renderer.shadowMap.needsUpdate = true;
  const dPrev = dimMat.opacity;
  dimMat.opacity += ((inspecting ? .42 : 0) - dimMat.opacity) * (1 - Math.exp(-dt * 5));
  if (Math.abs(dimMat.opacity - dPrev) > .002) active = true;

  blinkT += dt; if (blinkT > .5 && view <= 1 && !inspecting) { blinkT = 0; blinkOn = !blinkOn; lcdDirty = true; }
  if (lcdMsg && NOW >= lcdMsgUntil) { lcdMsg = null; lcdDirty = true; }
  if (lcdDirty) { drawLCD(); lcdDirty = false; active = true; }
  if (sheet && sheet.dirty) { uploadRegion(sheet.tex, sheet.ctx, sheet.dr); sheet.dirty = false; sheet.dr = null; active = true; }
  if (mipPending.size) { flushMips(!busy); active = true; }
  if (active || wake > 0) {
    renderer.autoClear = false; renderer.clear();
    renderer.render(scene, camera);
    if (dimMat.opacity > .002) renderer.render(dimScene, dimCam);
    if (heldScene.children.length > 2) { renderer.clearDepth(); renderer.render(heldScene, camera); }
    if (!active) wake--;
  }
}
boot().catch(e => {
  console.error('boot failed', e);
  if (!sheet) setSheet(new Sheet({ feed: .42 }));
  ready = true; document.getElementById('intro').classList.remove('loading');
  document.getElementById('introMsg').textContent = coarse ? 'tap to switch it on' : 'press any key to switch it on';
  document.getElementById('intro').addEventListener('pointerdown', ev => { if (!ev.target.closest('a')) powerOn(); });
}).finally(() => requestAnimationFrame(frame));

// The GPU can drop the context (tablets under memory pressure, a backgrounded tab, a driver reset).
// three rebuilds its buffers and textures on restore; the environment map and the shadow map are ours to redo.
canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); mipPending.clear(); });
canvas.addEventListener('webglcontextrestored', () => {
  scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture; heldScene.environment = scene.environment;
  renderer.shadowMap.needsUpdate = true; lcdDirty = true; invalidate(10);
});
