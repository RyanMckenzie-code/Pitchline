const $ = id => document.getElementById(id);
const names = 'C C♯ D D♯ E F F♯ G G♯ A A♯ B'.split(' ');
const presets = {'Standard':[40,45,50,55,59,64],'Drop D':[38,45,50,55,59,64],'DADGAD':[38,45,50,55,57,62],'Open G':[38,43,50,55,59,62],'Open D':[38,45,50,54,57,62],'Half step down':[39,44,49,54,58,63],'Custom':[40,45,50,55,59,64],'Chromatic':[]};
const frequency = midi => 440*2**((midi-69)/12);
const octave = midi => Math.floor(midi/12)-1;
const noteHTML = midi => names[midi%12]+'<sub>'+octave(midi)+'</sub>';
let selected=0, stream, context, analyser, buffer, frame, last=0, lastSignal=0;
let trackedHz = 0, lastLevel = 0, peakLevel = 0;
const targets=()=>presets[$('preset').value];
for(const key of Object.keys(presets)) $('preset').add(new Option(key,key));
for(let i=0;i<41;i++) $('ticks').append(document.createElement('b'));
function idle(){
 const midi=targets()[selected];
 $('note').innerHTML=midi===undefined?'—':noteHTML(midi);
 $('hz').textContent=midi===undefined?'Any note':frequency(midi).toFixed(2)+' Hz target';
 $('needle').style.left='50%';
 $('feedback').textContent=stream?'Play a string':'Ready to tune';
}
function draw(){
 trackedHz=0;lastSignal=0;
 $('strings').replaceChildren(); $('custom').replaceChildren();
 document.querySelector('.bank').hidden=!targets().length;
 targets().forEach((midi,index)=>{
 const b=document.createElement('button'); b.className='string';
 b.setAttribute('aria-pressed',index===selected);
 b.innerHTML='<span class="tag">STR '+(6-index)+'</span><strong>'+noteHTML(midi)+'</strong>';
 b.onclick=()=>{selected=index;draw()}; $('strings').append(b);
 });
 if($('preset').value==='Custom'){
 const div=document.createElement('div'); div.className='edit';
 const label=document.createElement('label');label.htmlFor='target';label.textContent='String '+(6-selected)+' target';
 const picker=document.createElement('select');picker.id='target';
 for(let midi=24;midi<=95;midi++)picker.add(new Option(names[midi%12]+octave(midi),midi));
 picker.value=targets()[selected];picker.onchange=()=>{targets()[selected]=Number(picker.value);draw()};
 div.append(label,picker);$('custom').append(div);
 }
 idle();
}
$('preset').onchange=()=>{selected=0;draw()};draw();
// Normalized squared difference, using the first periodic minimum (YIN).
function pitch(samples, rate, priorHz = 0, targetHz = 0, fading = false) {
 const maxLag = Math.min(Math.floor(rate / 29), samples.length >> 1);
 const window = samples.length - maxLag;
 // Subsample the comparisons but keep single-sample lag resolution.
 const stride = Math.max(1, Math.floor(rate / 12000));
 let energy = 0;
 for (let i = 0; i < samples.length; i += stride) energy += samples[i] ** 2;
 const rms = Math.sqrt(energy * stride / samples.length);
 if (rms < (priorHz ? 0.00006 : 0.00018)) return 0;

 let sum = 0, older = 1, previous = 1;
 for (let lag = 1; lag <= maxLag; lag++) {
   let difference = 0;
   for (let i = 0; i < window; i += stride) {
     const delta = samples[i] - samples[i + lag];
     difference += delta * delta;
   }
   sum += difference;
   const value = sum ? difference * lag / sum : 1;
   if (lag > rate / 2200 && older >= previous && value > previous) {
     const curvature = older - 2 * previous + value;
     const period = lag - 1 + (older - value) / (2 * curvature);
     const hz = rate / period;
     const followsString = priorHz && Math.abs(1200 * Math.log2(hz / priorHz)) < 75;
     if (previous < (followsString ? 0.35 : 0.13)) {
       // Align several cycles at once so small waveform ripples have less
       // influence on the final sub-sample estimate.
       const cycles = Math.max(1, Math.min(8, Math.floor(maxLag / period)));
       const center = Math.round(period * cycles);
       const radius = Math.max(3, Math.ceil(center * 0.035));
       const start = Math.max(1, center - radius);
       const end = Math.min(samples.length - window, center + radius);
       let best = center, smallest = Infinity;
       const costs = [];
       for (let offset = start; offset <= end; offset++) {
         let cost = 0;
         for (let i = 0; i < window; i += stride) cost += (samples[i] - samples[i + offset]) ** 2;
         costs[offset - start] = cost;
         if (cost < smallest) {smallest = cost; best = offset}
       }
       const k = best - start;
       const left = costs[k - 1], right = costs[k + 1];
       const bend = left + right - 2 * smallest;
       const fraction = bend > 0 ? (left - right) / (2 * bend) : 0;
       const measured = cycles * rate / (best + fraction);
       // Once a bass string rings, a shorter repeating cycle can be its
       // second or third harmonic. Check the actual longer cycle as well.
       const anchor = priorHz || targetHz;
       if (!anchor) return measured;
       const harmonic = Math.round(measured / anchor);
       if (harmonic < 2 || harmonic > 5) return measured;
       const fundamental = measured / harmonic;
       if (Math.abs(1200 * Math.log2(fundamental / anchor)) > 90) return measured;
       const fullPeriod = Math.round(rate / fundamental);
       if (fullPeriod > maxLag) return measured;
       const shortPeriod = Math.round(rate / measured);
       let fullError = 0, shortError = 0;
       for (let i = 0; i < window; i += stride) {
         fullError += (samples[i] - samples[i + fullPeriod]) ** 2;
         shortError += (samples[i] - samples[i + shortPeriod]) ** 2;
       }
       const lockedTarget = priorHz && targetHz && Math.abs(1200 * Math.log2(priorHz / targetHz)) < 150;
       const longerCycleFits = shortError > rms ** 2 * window / stride * 0.002 && fullError < shortError * 0.65;
       if (!lockedTarget && !fading && !longerCycleFits) return measured;
       // Estimate from the full waveform period, including any quieter
       // fundamental, rather than inheriting the overtone's pitch error.
       let bestPeriod = fullPeriod;
       const spread = Math.ceil(fullPeriod * 0.015);
       for (let offset = Math.max(1, fullPeriod - spread); offset <= Math.min(maxLag, fullPeriod + spread); offset++) {
         let error = 0;
         for (let i = 0; i < window; i += stride) error += (samples[i] - samples[i + offset]) ** 2;
         if (error < fullError) {fullError = error; bestPeriod = offset}
       }
       return rate / bestPeriod;
     }
   }
   older = previous;
   previous = value;
 }
 return 0;
}
function listen(time){
 if(time-last>40){
 last=time;analyser.getFloatTimeDomainData(buffer);
 const recent = time-lastSignal < 380;
 const midi = targets()[selected];
 let power = 0;
 for (let i = 0; i < buffer.length; i += 4) power += buffer[i] ** 2;
 const level = Math.sqrt(4 * power / buffer.length);
 const continuing = recent && trackedHz && level <= lastLevel * 1.6;
 peakLevel = continuing ? Math.max(level, peakLevel) : level;
 lastLevel = level;
 const hz=pitch(buffer,context.sampleRate,continuing ? trackedHz : 0, midi === undefined ? 0 : frequency(midi), continuing && level < peakLevel * 0.3);
 if(hz){
 const close = recent && trackedHz && Math.abs(1200*Math.log2(hz/trackedHz))<40;
 trackedHz=close ? 0.55*hz + 0.45*trackedHz : hz;
 lastSignal=time;
 const exact=69+12*Math.log2(trackedHz/440), target=targets()[selected]??Math.round(exact);
 const cents=Math.round((exact-target)*100);
 $('note').innerHTML=noteHTML(target);$('hz').textContent=trackedHz.toFixed(2)+' Hz';
 $('needle').style.left=Math.max(0,Math.min(100,50+cents))+'%';
 $('feedback').textContent=Math.abs(cents)<=4?'In tune':(cents<0?'Tune up':'Tune down')+' · '+(cents>0?'+':'')+cents+' cents';
 }else if(time-lastSignal>380){trackedHz=0;idle()}
 }
 frame=requestAnimationFrame(listen);
}
function stop(){
 cancelAnimationFrame(frame);trackedHz=0;lastSignal=0;if(stream)stream.getTracks().forEach(t=>t.stop());
 stream=null;if(context)context.close().catch(()=>{});context=null;
 $('status').textContent='●  MIC OFF';$('mic').lastElementChild.textContent='Enable microphone';idle();
}
$('mic').onclick=async()=>{
 if(stream){stop();return}
 $('mic').disabled=true;
 try{
 context=new AudioContext();await context.resume();
 stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
 analyser=context.createAnalyser();analyser.fftSize=context.sampleRate>64000?8192:4096;
 const filter=context.createBiquadFilter();filter.type="lowpass";filter.frequency.value=2300;filter.Q.value=0.707;
 context.createMediaStreamSource(stream).connect(filter).connect(analyser);buffer=new Float32Array(analyser.fftSize);
 stream.getAudioTracks()[0].onended=stop;
 $('status').textContent='●  LISTENING';$('mic').lastElementChild.textContent='Stop microphone';idle();frame=requestAnimationFrame(listen);
 }catch(e){stop();$('feedback').textContent=e.name==='NotAllowedError'?'Allow microphone access in your browser, then try again.':'Microphone unavailable. Check your input and try again.'}
 finally{$('mic').disabled=false}
};
window.addEventListener('pagehide',stop);
