# Recreate Pitchline in VS Code

This folder contains the three files served by the published tuner, including the low E fix. Open this folder to run the reference. For a from-scratch build, keep it open in one VS Code window and create a second, empty project in another.

## 1. Run the reference

From the directory containing index.html, start a local server:

```sh
python -m http.server 8000
```

On Windows, try `py -m http.server 8000` if Python is installed through the launcher. On macOS or Linux, try `python3`. Open http://localhost:8000 directly in your browser, click Enable microphone, and allow access. Use HTTPS when hosting online. Your browser processes the audio locally. The app never connects its mic signal to your speakers.

## 2. Get one string working without audio

In your empty project, start with index.html and tuner.js. Put a single empty output element with id="reading" in the page, then load tuner.js with a script tag after the output. Start with a hard-coded frequency so you can test the display and the math separately from microphone permissions.

```js
function centsFromTarget(measuredHz, targetHz) {
  return 1200 * Math.log2(measuredHz / targetHz);
}

const lowE = 440 * 2 ** ((40 - 69) / 12);
const cents = centsFromTarget(83, lowE);
document.querySelector("#reading").textContent = cents.toFixed(1) + " cents";
```

At 83 Hz the result should be about +12.4 cents. That means sharp: loosen the string slightly. Replace 83 with lowE and expect zero. Double lowE and expect +1200. A ratio matters here because the same musical interval spans different numbers of hertz on different strings.

## 3. Capture a waveform

Add a microphone button. In its click handler, create and resume an AudioContext, request a stream, connect it to an analyser, and allocate the sample buffer. Look for the mic button handler near the bottom of tuner.js for the complete implementation, including permission errors and cleanup. This abbreviated setup shows the path:

```js
const context = new AudioContext();
await context.resume();
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
});
const analyser = context.createAnalyser();
analyser.fftSize = context.sampleRate > 64000 ? 8192 : 4096;
const input = context.createMediaStreamSource(stream);
input.connect(analyser);
const samples = new Float32Array(analyser.fftSize);
```

These statements belong inside an async click handler. The finished tuner also places a 2300 Hz low-pass filter between input and analyser. Inside a requestAnimationFrame loop, call analyser.getFloatTimeDomainData(samples) to refresh the array. As a checkpoint, display its largest absolute sample value: it should rise on a pluck and fall as the sound decays. Use the actual context.sampleRate for every time-to-frequency conversion.

## 4. Turn repetition into pitch

Open pitch() in tuner.js. At 48,000 samples per second, an 82.41 Hz low E repeats roughly every 582.5 samples. Imagine sliding a copy of the waveform along the original. At a shift of one period, corresponding samples should be similar. This is the idea behind the detector's inner loop:

```js
const delta = samples[i] - samples[i + lag];
difference += delta * delta;
```

For your first pitch-reading prototype, copy pitch() into your new project and call it with only samples and context.sampleRate. A positive return value is the frequency estimate. Zero asks the UI to wait for a credible reading. Then work through the function in this order:

1. RMS measures the strength of the waveform and gates very quiet frames.
2. For each possible lag, the detector sums the squared differences and normalizes the result against the average of the differences seen so far. This avoids choosing a tiny lag just because adjacent samples look alike.
3. It looks for an early, sufficiently deep local minimum. It interpolates around the minimum and compares several cycles to refine the estimate. Frequency in hertz equals sample rate divided by samples per cycle.
4. The final section checks whether the candidate might be an overtone. Leave this section until step 7 when implementing your own detector.

Try the detector without plugging in a guitar. Put this after your pitch function:

```js
const rate = 48000;
const tone = Float32Array.from({ length: 4096 }, (_, i) =>
  0.2 * Math.sin(2 * Math.PI * 110 * i / rate)
);
console.log(pitch(tone, rate)); // Approximately 110 Hz (open A).
```

## 5. Choose what pitch to compare against

The presets object in tuner.js stores six MIDI note numbers from the thickest string to the thinnest. E2 is 40, A2 is 45, and A4 is 69. Adding one raises a pitch one semitone. Standard tuning is [40,45,50,55,59,64]. Drop D changes only the first entry to 38. Custom mode lets the user replace each entry independently.

In preset or custom mode, compare the measurement with the selected string. In chromatic mode, convert the measurement to a fractional MIDI number, then round it to select the nearest target. The fractional part gives the cents error:

```js
const exactMidi = 69 + 12 * Math.log2(measuredHz / 440);
const targetMidi = selectedStringMidi ?? Math.round(exactMidi);
const cents = Math.round(100 * (exactMidi - targetMidi));
```

Here selectedStringMidi is undefined in chromatic mode. In the finished source, targets()[selected] supplies it. Test this distinction by selecting low E and playing F2. The fixed target should read about +100 cents. Chromatic should identify F2 near zero cents.

## 6. Follow one pluck through its decay

Read listen(time). The browser schedules frames continuously. Pitchline checks the buffer once more than 40 ms have elapsed. It remembers the last credible frequency and the time and strength of that reading.

- Once a pitch is established, the RMS gate drops from 0.00018 to 0.00006 so a fading note can still register.
- For consecutive measurements less than 40 cents apart, the display blends 55% new frequency with 45% previous frequency. Large changes can register immediately.
- A short gap under 380 ms can retain the last reading. Longer silence returns the tuner to idle. A sudden increase in input level can indicate a fresh pluck and resets continuity for pitch detection.
- The meter centers at zero and reaches its edges at ±50 cents. The numeric text can show larger errors. The display labels readings within ±4 cents as in tune.

Rebuild this after your first live readout works. Playing a string and then muting it with your palm tests both the sustain behavior and the return to idle.

## 7. Reproduce and fix the low E octave jump

Low E vibrates near 82.41 Hz. Its second harmonic is near 164.81 Hz. If that harmonic stays strong as the fundamental fades, the waveform can look like it repeats every half-period. A detector that accepts that shorter period reports a pitch one octave sharp.

To reproduce this, replace the single sine wave from step 4 with the sum of two: a fundamental whose amplitude decays quickly and a second harmonic whose amplitude decays slowly. For each successive frame, advance t through the simulated recording:

```js
function lowESample(t) {
  const phase = 2 * Math.PI * 82.4069 * t;
  return 0.12 * Math.exp(-2.2 * t) * Math.sin(phase)
       + 0.08 * Math.exp(-0.75 * t) * Math.sin(2 * phase);
}
let priorHz = 0;
for (let frame = 0; frame <= 80; frame++) {
  const start = frame * 0.05;
  const samples = Float32Array.from({ length: 4096 }, (_, i) =>
    lowESample(start + i / 48000)
  );
  priorHz = pitch(samples, 48000, priorHz, 82.4069);
  console.log(start.toFixed(2), priorHz.toFixed(2));
}
```

Run this once with the full detector. Then, in your practice copy, insert `return measured;` directly before `const anchor = priorHz || targetHz;` and run it again. The second run exposes the octave jump. Remove the temporary return to restore the fix.

The fix compares the candidate with a recently tracked pitch or the selected target. When it is close to a 2nd–5th harmonic, it compares waveform alignment at both the short and long periods. A previously established target, a fading note, or a stronger fit at the long period can justify using the longer period. It searches nearby lags to estimate the actual frequency, so a slightly sharp low E can still read sharp. This is a heuristic: when only a single overtone remains, the waveform alone cannot uniquely identify which string produced it.

## 8. Finish the interface and shutdown

In index.html, identify the pitch display, meter, preset selector, microphone button, and string bank. In tuner.js, draw() rebuilds the string buttons when the tuning changes. idle() shows the target and resets the meter. stop() cancels the animation loop, stops the microphone tracks, and closes the audio context. Use style.css as the last layer once you can tune a string using text alone.

A final hands-on check: tune each open string, switch from Standard to Drop D, set one custom target, then switch to Chromatic and play a short scale. Listen for one string at a time and watch whether a new pluck takes over cleanly.
