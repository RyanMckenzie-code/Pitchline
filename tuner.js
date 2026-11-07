const $ = (id) => document.getElementById(id);
const names = "C C\u266f D D\u266f E F F\u266f G G\u266f A A\u266f B".split(
  " ",
);
const presets = {
  Standard: [40, 45, 50, 55, 59, 64],
  "Drop D": [38, 45, 50, 55, 59, 64],
  DADGAD: [38, 45, 50, 55, 57, 62],
  "Open G": [38, 43, 50, 55, 59, 62],
  "Open D": [38, 45, 50, 54, 57, 62],
  "Half step down": [39, 44, 49, 54, 58, 63],
  Custom: [40, 45, 50, 55, 59, 64],
  Chromatic: [],
};
const frequency = (midi) => 440 * 2 ** ((midi - 69) / 12);
const octave = (midi) => Math.floor(midi / 12) - 1;
const noteHTML = (midi) => names[midi % 12] + "<sub>" + octave(midi) + "</sub>";
let selected = 0,
  stream,
  context,
  analyser,
  buffer,
  frame,
  last = 0,
  lastSignal = 0;
let trackedHz = 0,
  lastLevel = 0,
  peakLevel = 0;
let automatic = true;
let detectedString = false;
let candidateString = -1;
let candidateFrames = 0;
let stableSince = 0;
const tunedStrings = new Set();
const isAutomatic = () => automatic && $("preset").value === "Standard";
const targets = () => presets[$("preset").value];
// Initialization and event handlers.
function initializeTuner() {
  for (const key of Object.keys(presets)) {
    $("preset").add(new Option(key, key));
  }
  for (let i = 0; i < 41; i++) {
    $("ticks").append(document.createElement("b"));
  }
  $("preset").onchange = handlePresetChange;
  $("mic").onclick = toggleMicrophone;
  $("auto-mode").onclick = () => setSelectionMode(true);
  $("manual-mode").onclick = () => setSelectionMode(false);
  updateModeControls();
  window.addEventListener("pagehide", stopMicrophone);
  renderStrings();
}

function handlePresetChange() {
  selected = 0;
  tunedStrings.clear();
  updateModeControls();
  renderStrings();
}

function selectString(index) {
  setSelectionMode(false);
  selected = index;
  renderStrings();
}

function updateCustomTarget(event) {
  targets()[selected] = Number(event.target.value);
  renderStrings();
}

// Selection modes and automatic string recognition.
function setSelectionMode(enabled) {
  automatic = enabled;
  if (enabled) $("preset").value = "Standard";
  updateModeControls();
  renderStrings();
}

function updateModeControls() {
  const auto = isAutomatic();
  $("auto-mode").setAttribute("aria-pressed", auto);
  $("manual-mode").setAttribute("aria-pressed", !auto);
  $("mode-hint").textContent = auto ? "AUTOMATIC DETECTION" : "SELECT A STRING";
  $("instruction").textContent = auto
    ? "Play any open string. Pitchline finds it for you."
    : "Choose a string above, then play it open.";
}

function findNearestString(hz) {
  const midi = 69 + 12 * Math.log2(hz / 440);
  return presets.Standard.reduce(
    (best, target, index, notes) =>
      Math.abs(target - midi) < Math.abs(notes[best] - midi) ? index : best,
    0,
  );
}

function recognizeString(hz) {
  const nearest = findNearestString(hz);
  if (nearest !== candidateString) {
    candidateString = nearest;
    candidateFrames = 1;
  } else {
    candidateFrames++;
  }
  // Require three consecutive estimates before changing the target.
  if (candidateFrames >= 3 && (!detectedString || nearest !== selected)) {
    selected = nearest;
    detectedString = true;
    stableSince = 0;
    updateStringHighlights();
  }
}

function updateStringHighlights() {
  $("strings")
    .querySelectorAll("button")
    .forEach((button, index) => {
      button.setAttribute(
        "aria-pressed",
        index === selected && (!isAutomatic() || detectedString),
      );
      button.classList.toggle("tuned", tunedStrings.has(index));
    });
}

// String selection and idle display.
function renderIdleDisplay() {
  const midi = isAutomatic() ? undefined : targets()[selected];
  document.querySelector(".screen").dataset.state = "idle";
  $("note").innerHTML = midi === undefined ? "\u2014" : noteHTML(midi);
  $("hz").textContent =
    midi === undefined
      ? "Waiting for a string"
      : frequency(midi).toFixed(2) + " Hz target";
  $("needle").style.left = "50%";
  $("feedback").textContent = stream
    ? "Play an open string"
    : "Ready when you are";
  $("tuning-detail").textContent = stream
    ? isAutomatic()
      ? "Listening for E \u00b7 A \u00b7 D \u00b7 G \u00b7 B \u00b7 E"
      : "Let the note ring out"
    : "Enable your microphone to get started";
  stableSince = 0;
}
function renderStrings() {
  trackedHz = 0;
  lastSignal = 0;
  detectedString = false;
  candidateString = -1;
  candidateFrames = 0;
  $("strings").replaceChildren();
  $("custom").replaceChildren();
  document.querySelector(".bank").hidden = !targets().length;
  targets().forEach((midi, index) => {
    const b = document.createElement("button");
    b.className = "string";
    b.setAttribute("aria-pressed", index === selected);
    b.innerHTML =
      '<span class="tag">STR ' +
      (6 - index) +
      "</span><strong>" +
      noteHTML(midi) +
      "</strong>";
    b.onclick = () => selectString(index);
    $("strings").append(b);
  });
  if ($("preset").value === "Custom") {
    const div = document.createElement("div");
    div.className = "edit";
    const label = document.createElement("label");
    label.htmlFor = "target";
    label.textContent = "String " + (6 - selected) + " target";
    const picker = document.createElement("select");
    picker.id = "target";
    for (let midi = 24; midi <= 95; midi++)
      picker.add(new Option(names[midi % 12] + octave(midi), midi));
    picker.value = targets()[selected];
    picker.onchange = updateCustomTarget;
    div.append(label, picker);
    $("custom").append(div);
  }
  updateStringHighlights();
  renderIdleDisplay();
}

// Normalized squared difference, using the first periodic minimum (YIN).
function detectPitch(samples, rate, priorHz = 0, targetHz = 0, fading = false) {
  const maxLag = Math.min(Math.floor(rate / 29), samples.length >> 1);
  const window = samples.length - maxLag;
  // Subsample the comparisons but keep single-sample lag resolution.
  const stride = Math.max(1, Math.floor(rate / 12000));
  let energy = 0;
  for (let i = 0; i < samples.length; i += stride) energy += samples[i] ** 2;
  const rms = Math.sqrt((energy * stride) / samples.length);
  if (rms < (priorHz ? 0.00006 : 0.00018)) return 0;

  let sum = 0,
    older = 1,
    previous = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let difference = 0;
    for (let i = 0; i < window; i += stride) {
      const delta = samples[i] - samples[i + lag];
      difference += delta * delta;
    }
    sum += difference;
    const value = sum ? (difference * lag) / sum : 1;
    if (lag > rate / 2200 && older >= previous && value > previous) {
      const curvature = older - 2 * previous + value;
      const period = lag - 1 + (older - value) / (2 * curvature);
      const hz = rate / period;
      const followsString =
        priorHz && Math.abs(1200 * Math.log2(hz / priorHz)) < 75;
      if (previous < (followsString ? 0.35 : 0.13)) {
        // Align several cycles at once so small waveform ripples have less
        // influence on the final sub-sample estimate.
        const cycles = Math.max(1, Math.min(8, Math.floor(maxLag / period)));
        const center = Math.round(period * cycles);
        const radius = Math.max(3, Math.ceil(center * 0.035));
        const start = Math.max(1, center - radius);
        const end = Math.min(samples.length - window, center + radius);
        let best = center,
          smallest = Infinity;
        const costs = [];
        for (let offset = start; offset <= end; offset++) {
          let cost = 0;
          for (let i = 0; i < window; i += stride)
            cost += (samples[i] - samples[i + offset]) ** 2;
          costs[offset - start] = cost;
          if (cost < smallest) {
            smallest = cost;
            best = offset;
          }
        }
        const k = best - start;
        const left = costs[k - 1],
          right = costs[k + 1];
        const bend = left + right - 2 * smallest;
        const fraction = bend > 0 ? (left - right) / (2 * bend) : 0;
        const measured = (cycles * rate) / (best + fraction);
        // Once a bass string rings, a shorter repeating cycle can be its
        // second or third harmonic. Check the actual longer cycle as well.
        const anchor = priorHz || targetHz;
        if (!anchor) return measured;
        const harmonic = Math.round(measured / anchor);
        if (harmonic < 2 || harmonic > 5) return measured;
        const fundamental = measured / harmonic;
        if (Math.abs(1200 * Math.log2(fundamental / anchor)) > 90)
          return measured;
        const fullPeriod = Math.round(rate / fundamental);
        if (fullPeriod > maxLag) return measured;
        const shortPeriod = Math.round(rate / measured);
        let fullError = 0,
          shortError = 0;
        for (let i = 0; i < window; i += stride) {
          fullError += (samples[i] - samples[i + fullPeriod]) ** 2;
          shortError += (samples[i] - samples[i + shortPeriod]) ** 2;
        }
        const lockedTarget =
          priorHz &&
          targetHz &&
          Math.abs(1200 * Math.log2(priorHz / targetHz)) < 150;
        const longerCycleFits =
          shortError > ((rms ** 2 * window) / stride) * 0.002 &&
          fullError < shortError * 0.65;
        if (!lockedTarget && !fading && !longerCycleFits) return measured;
        // Estimate from the full waveform period, including any quieter
        // fundamental, rather than inheriting the overtone's pitch error.
        let bestPeriod = fullPeriod;
        const spread = Math.ceil(fullPeriod * 0.015);
        for (
          let offset = Math.max(1, fullPeriod - spread);
          offset <= Math.min(maxLag, fullPeriod + spread);
          offset++
        ) {
          let error = 0;
          for (let i = 0; i < window; i += stride)
            error += (samples[i] - samples[i + offset]) ** 2;
          if (error < fullError) {
            fullError = error;
            bestPeriod = offset;
          }
        }
        return rate / bestPeriod;
      }
    }
    older = previous;
    previous = value;
  }
  return 0;
}
// Audio sampling and live pitch display.
function processAudioFrame(time) {
  if (time - last > 40) {
    last = time;
    analyser.getFloatTimeDomainData(buffer);
    const recent = time - lastSignal < 380;
    const midi = targets()[selected];
    let power = 0;
    for (let i = 0; i < buffer.length; i += 4) power += buffer[i] ** 2;
    const level = Math.sqrt((4 * power) / buffer.length);
    const continuing = recent && trackedHz && level <= lastLevel * 1.6;
    peakLevel = continuing ? Math.max(level, peakLevel) : level;
    lastLevel = level;
    const hz = detectPitch(
      buffer,
      context.sampleRate,
      continuing ? trackedHz : 0,
      isAutomatic() || midi === undefined ? 0 : frequency(midi),
      continuing && level < peakLevel * 0.3,
    );
    if (hz) {
      if (isAutomatic()) recognizeString(hz);
      const close =
        recent && trackedHz && Math.abs(1200 * Math.log2(hz / trackedHz)) < 40;
      trackedHz = close ? 0.55 * hz + 0.45 * trackedHz : hz;
      lastSignal = time;
      if (!isAutomatic() || detectedString) renderPitch(trackedHz, time);
    } else if (time - lastSignal > 380) {
      trackedHz = 0;
      candidateString = -1;
      candidateFrames = 0;
      detectedString = false;
      updateStringHighlights();
      renderIdleDisplay();
    }
  }
  frame = requestAnimationFrame(processAudioFrame);
}
// Pitch feedback and sustained in-tune confirmation.
function renderPitch(hz, time) {
  const exact = 69 + 12 * Math.log2(hz / 440);
  const target = targets()[selected] ?? Math.round(exact);
  const cents = Math.round((exact - target) * 100);
  const inTune = Math.abs(cents) <= 4;
  document.querySelector(".screen").dataset.state = inTune
    ? "tuned"
    : "tracking";
  $("note").innerHTML = noteHTML(target);
  $("hz").textContent = hz.toFixed(2) + " Hz";
  $("needle").style.left = Math.max(0, Math.min(100, 50 + cents)) + "%";
  $("feedback").textContent = inTune
    ? "Right on pitch"
    : cents < 0
      ? "A little higher"
      : "A little lower";
  $("tuning-detail").textContent = inTune
    ? "In tune \u00b7 let it ring"
    : (cents > 0 ? "+" : "") +
      cents +
      " cents \u00b7 " +
      (cents < 0 ? "tighten" : "loosen") +
      " the string";
  if (inTune) {
    if (!stableSince) stableSince = time;
    if (time - stableSince > 650 && targets().length) {
      tunedStrings.add(selected);
      updateStringHighlights();
    }
  } else {
    stableSince = 0;
  }
}

// Microphone lifecycle.
function stopMicrophone() {
  cancelAnimationFrame(frame);
  trackedHz = 0;
  lastSignal = 0;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (context) context.close().catch(() => {});
  context = null;
  $("status").textContent = "MIC OFF";
  document.body.classList.remove("listening");
  $("mic").lastElementChild.textContent = "Enable microphone";
  renderIdleDisplay();
}
async function toggleMicrophone() {
  if (stream) {
    stopMicrophone();
    return;
  }
  $("mic").disabled = true;
  try {
    context = new AudioContext();
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    analyser = context.createAnalyser();
    analyser.fftSize = context.sampleRate > 64000 ? 8192 : 4096;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2300;
    filter.Q.value = 0.707;
    context.createMediaStreamSource(stream).connect(filter).connect(analyser);
    buffer = new Float32Array(analyser.fftSize);
    stream.getAudioTracks()[0].onended = stopMicrophone;
    $("status").textContent = "LISTENING";
    document.body.classList.add("listening");
    $("mic").lastElementChild.textContent = "Stop microphone";
    renderIdleDisplay();
    frame = requestAnimationFrame(processAudioFrame);
  } catch (e) {
    stopMicrophone();
    $("feedback").textContent =
      e.name === "NotAllowedError"
        ? "Allow microphone access in your browser, then try again."
        : "Microphone unavailable. Check your input and try again.";
  } finally {
    $("mic").disabled = false;
  }
}
initializeTuner();
