// Entry: phones get the introduction only (the desk needs room), so they never download the 3D engine.
// Everything else loads the app.
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './style.css';

const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
if (phone) {
  const intro = document.getElementById('intro');
  intro.classList.remove('loading'); intro.classList.add('phone');
  document.getElementById('introMsg').hidden = true;
  document.getElementById('introDevice').hidden = false;
} else {
  // Hold the heavy start (the 3D engine parsing, textures, shaders) until the mark has drawn itself:
  // the start screen's first second is its animation, and main-thread work there makes it stutter.
  // The prompt only appears after ~2.5s anyway, so this costs no waiting.
  const go = () => { go.done || import('./main.js'); go.done = true; };
  const shaft = document.querySelector('#intro .mark .shaft');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !shaft) go();
  else { shaft.addEventListener('animationend', go, { once: true }); setTimeout(go, 2000); }
}
