// The part of spessasynth_lib 4.3.14 that the tools call (see NOTICE).
export interface SynthMethodOptions { time: number; }

export class WorkletSynthesizer {
  constructor(context: BaseAudioContext);
  readonly isReady: Promise<unknown>;
  readonly soundBankManager: { addSoundBank(bank: ArrayBuffer, id: string): Promise<void> };
  connect(destination: AudioNode): AudioNode;
  noteOn(channel: number, key: number, velocity: number, options?: SynthMethodOptions): void;
  noteOff(channel: number, key: number, options?: SynthMethodOptions): void;
  controllerChange(channel: number, controller: number, value: number, options?: SynthMethodOptions): void;
  pitchWheel(channel: number, value: number, options?: SynthMethodOptions): void;
  pitchWheelRange(channel: number, semitones: number, options?: SynthMethodOptions): void;
  programChange(channel: number, program: number, options?: SynthMethodOptions): void;
  stopAll(force?: boolean): void;
}
