import { EngineSynth } from './engine-core.js';

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const p = (name, max) => ({ name, defaultValue: 0, minValue: 0, maxValue: max, automationRate: 'k-rate' });
    return [p('rpm', 15000), p('load', 1), p('overrun', 1), p('cut', 1), p('crank', 1)];
  }
  constructor() {
    super();
    this.synth = new EngineSynth(sampleRate);
    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'car') this.synth.setCar(m.engine);
      else if (m.type === 'crackle') this.synth.crackleUser = m.value;
    };
  }
  process(inputs, outputs, params) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    this.synth.render(L, R, L.length, {
      rpm: params.rpm[0], load: params.load[0], overrun: params.overrun[0],
      cut: params.cut[0], crank: params.crank[0],
    });
    return true;
  }
}

registerProcessor('engine-processor', EngineProcessor);
