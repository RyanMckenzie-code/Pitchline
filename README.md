# Pitchline

Pitchline is a browser-based guitar tuner that uses your microphone to estimate the pitch of a single string in real time. It pairs automatic standard-tuning string selection with a focused dark interface, a moving cents meter, and blue-to-green visual feedback as you reach the target pitch.

## Features

- **Automatic standard tuning:** identifies the nearest open string in E2, A2, D3, G3, B3, E4 tuning. Three consecutive estimates must agree before the selected string changes.
- **Manual string selection:** click a string to tune against a fixed target. Clicking a string switches to Manual mode.
- **Alternate tunings:** Standard, Drop D, DADGAD, Open G, Open D, and Half step down.
- **Custom tuning:** assign each string a target note from MIDI 24 through 95 (C1 through B6). These are selectable targets, not a guarantee of reliable detection across that entire range.
- **Chromatic mode:** compares the detected pitch with the nearest equal-tempered note instead of a fixed string target.
- **Live feedback:** displays the target note, measured frequency in hertz, cents deviation, and whether to tighten or loosen the string.
- **In-tune confirmation:** rounded readings within +/-4 cents turn the display green. Holding that state for more than 650 ms adds a checkmark to the string.
- **Responsive interface:** supports smaller screens, keyboard focus indicators, and reduced-motion preferences.
- **Local audio processing:** microphone audio is analyzed in the browser without being uploaded or recorded by the application.

Checkmarks indicate previously confirmed strings; they are not continuous measurements of every string. They remain in memory and reset when the tuning preset changes or the page reloads.

## Technology stack

| Technology | Role |
| --- | --- |
| HTML5 | Page structure, controls, and accessible labels |
| CSS3 | Dark blue and green theme, responsive layouts, meter transitions, and in-tune animation |
| Vanilla JavaScript | Pitch detection, string recognition, application state, and display updates |
| Media Capture API | Requests microphone access through `navigator.mediaDevices.getUserMedia()` |
| Web Audio API | Captures, filters, and reads waveform samples using `AudioContext`, `BiquadFilterNode`, and `AnalyserNode` |
| `requestAnimationFrame()` | Schedules the live processing and display loop |

There are no third-party runtime dependencies, frontend frameworks, package installation steps, or build tools required to run the project.

## Architecture: everything runs in the browser

Pitchline currently has **no server-side backend**, database, authentication service, or external pitch detection API. The processing logic lives in `tuner.js` and runs on the browser's main thread. A static web server only delivers the HTML, CSS, and JavaScript files.

```text
Microphone
    |
    v
MediaStream -> AudioContext -> 2300 Hz low-pass filter
    |
    v
AnalyserNode -> waveform sample buffer
    |
    v
YIN-style pitch estimation -> frequency tracking
    |
    v
Automatic string selection or manual/chromatic target
    |
    v
Cents calculation -> note display, needle, halo, and checkmarks
```

The audio graph is not connected to the speakers, so the tuner does not play back microphone input. Stopping the microphone cancels the animation loop, stops the stream tracks, and closes the audio context. The app also requests cleanup when the page is hidden through the `pagehide` event.

## How the tuner works

### 1. Capture and filter the signal

Microphone access starts when the user presses **Enable microphone**. The app requests that echo cancellation, noise suppression, and automatic gain control be disabled to reduce speech-oriented processing; browser and device support determines whether those requests are honored.

A low-pass filter with a 2300 Hz cutoff and Q of 0.707 reduces high-frequency content before waveform analysis. The analyser uses a buffer of 4096 samples, or 8192 when the audio context's sample rate exceeds 64 kHz. The loop analyzes a new buffer when more than 40 ms have elapsed since the previous analysis. Actual update timing depends on browser scheduling and processing load.

### 2. Estimate the waveform's repetition period

`detectPitch()` implements a YIN-style normalized squared-difference detector in the time domain. Although it uses an `AnalyserNode`, it reads waveform samples rather than using an FFT spectrum for pitch estimation.

The detector:

1. Estimates signal strength using RMS and rejects very quiet input.
2. Compares the waveform with shifted copies of itself across candidate delays, called lags.
3. Normalizes the squared differences using their cumulative mean.
4. Finds an early, sufficiently deep local minimum that suggests a repeating period.
5. Refines the estimate using interpolation and waveform alignment over multiple cycles.
6. Converts the period into frequency using the actual audio context sample rate.

```text
frequency (Hz) = sample rate / period in samples
```

A recent tracked pitch lowers the quiet-signal threshold so a decaying note can remain detectable. When a previous pitch or manually selected target is available, additional harmonic checks compare short and long waveform periods to help reduce octave jumps. These checks are heuristic and do not eliminate harmonic ambiguity.

### 3. Choose a target note

In **Auto mode**, Pitchline converts the measured frequency into a fractional MIDI note number and chooses the closest standard-tuning string by musical interval. It requires three consecutive estimates to agree before accepting a new string. Auto mode applies only to Standard tuning; pressing Auto switches the preset to Standard.

In **Manual mode**, the selected string supplies the target MIDI note. Alternate presets and custom targets use this fixed-target behavior.

In **Chromatic mode**, the fractional MIDI value is rounded to select the closest note.

All pitch calculations use equal temperament with A4 fixed at 440 Hz:

```js
const targetHz = 440 * 2 ** ((targetMidi - 69) / 12);
const exactMidi = 69 + 12 * Math.log2(measuredHz / 440);
const cents = Math.round((exactMidi - targetMidi) * 100);
```

There are 100 cents in one semitone. Negative cents mean flat; positive cents mean sharp.

### 4. Stabilize the reading and update the interface

Consecutive measurements less than 40 cents apart are blended using 55% new frequency and 45% previous frequency. Larger changes are accepted without that blend. A recent reading can bridge short detection gaps; after more than 380 ms without a detected pitch, the display returns to idle.

The needle covers -50 to +50 cents and stays at the edge for larger deviations, while the text can display the full error. The green halo signals the in-tune range, and sustained readings add a string checkmark.

## Project files

```text
Pitchline/
|-- index.html    Page layout, tuner controls, and display elements
|-- style.css     Theme, responsive styling, and visual feedback
|-- tuner.js      Audio capture, DSP, target selection, and UI logic
`-- README.md     Project overview and technical documentation
```

Key JavaScript functions:

| Function | Responsibility |
| --- | --- |
| `initializeTuner()` | Populates controls and registers event handlers |
| `toggleMicrophone()` / `stopMicrophone()` | Starts and releases audio resources |
| `detectPitch()` | Estimates frequency from waveform samples |
| `processAudioFrame()` | Samples audio, tracks pitch, and triggers display updates |
| `findNearestString()` / `recognizeString()` | Selects a standard-tuning target in Auto mode |
| `renderPitch()` | Calculates cents and updates tuning feedback |
| `renderStrings()` / `renderIdleDisplay()` | Builds string controls and restores the waiting display |

## Run locally

From the project directory, start a static server:

```sh
python -m http.server 8000
```

On Windows, `py -m http.server 8000` is another option. Open **http://localhost:8000**, enable the microphone, and allow browser access. Python is only a convenient development server; it is not part of the application runtime.

For deployment, serve the files over **HTTPS**. Microphone access requires a secure context such as HTTPS or localhost. Use a browser with support for the Web Audio and Media Capture APIs.

## Using Pitchline

1. Leave **Standard / Auto** selected to detect open guitar strings automatically, or choose a preset and select a string manually.
2. Enable the microphone and pluck one open string at a time.
3. Follow the direction cue: tighten when flat and loosen when sharp.
4. Let the pitch settle near the center until the display turns green and the string receives a checkmark.
5. Mute the string before moving to the next one, and stop the microphone when finished.

## Current limitations

- The detector is monophonic: it is designed for one sounding note, not chords.
- Automatic selection chooses the nearest standard-tuning pitch. A heavily detuned string or a dominant harmonic can cause the wrong string to be selected.
- Microphone response, background noise, picking attack, and device audio processing can affect readings.
- Detection runs on the main thread, so performance and timing vary with the device and browser.
- Preset edits and checkmarks are not saved between page loads.
- Synthetic signal checks have been performed during development; comprehensive real-guitar, microphone, browser, accuracy, and latency benchmarks have not yet been established.
