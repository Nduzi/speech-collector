/** Microphone (and file-injection) sources feeding raw Float32 chunks at the *actual* hardware sample rate. */

export interface MicSettings {
  deviceId?: string;
  autoGainControl: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
}

export class MicError extends Error {
  kind: "denied" | "no-device" | "busy" | "insecure" | "unsupported" | "other";
  constructor(kind: MicError["kind"], msg: string) {
    super(msg);
    this.kind = kind;
  }
}

const WORKLET = `
class Cap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('cap-processor', Cap);
`;

export function describeMicError(e: any): MicError {
  const name = e?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return new MicError("denied", "Microphone permission was denied. Allow microphone access for this site in the browser's address-bar/site settings, then try again.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new MicError("no-device", "No microphone was found (or the selected one is unavailable). Connect a microphone and try again.");
  if (name === "NotReadableError" || name === "AbortError") return new MicError("busy", "The microphone could not be opened - another application may be using it.");
  return new MicError("other", `Could not start the microphone: ${e?.message ?? e}`);
}

export class MicSource {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: AudioNode;
  sampleRate = 0;
  trackLabel = "";
  trackSettings: MediaTrackSettings = {};

  async start(settings: MicSettings, onChunk: (c: Float32Array) => void): Promise<{ sampleRate: number; label: string; settings: MediaTrackSettings }> {
    if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
      throw new MicError("insecure", "Browsers only allow microphone access on secure (https://) pages. Please open the link you were sent, not a copy of the page.");
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError("unsupported", "This browser does not support microphone capture (getUserMedia).");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.deviceId ? { exact: settings.deviceId } : undefined,
          channelCount: 1,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
        },
      });
    } catch (e) {
      throw describeMicError(e);
    }
    const track = this.stream.getAudioTracks()[0];
    this.trackLabel = track?.label ?? "";
    this.trackSettings = track?.getSettings() ?? {};
    // No sampleRate hint: take whatever the device/context runs at and report it truthfully.
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(this.stream);
    if (this.ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(this.ctx, "cap-processor", { numberOfOutputs: 0 });
      node.port.onmessage = (e) => onChunk(e.data as Float32Array);
      src.connect(node);
      this.node = node;
    } else {
      const sp = this.ctx.createScriptProcessor(2048, 1, 1);
      sp.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(sp);
      sp.connect(this.ctx.destination);
      this.node = sp;
    }
    return { sampleRate: this.sampleRate, label: this.trackLabel, settings: this.trackSettings };
  }

  /** Release the microphone: every track is stopped so the browser's recording indicator turns off. */
  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    try { this.node?.disconnect(); } catch { /* already disconnected */ }
    this.ctx?.close().catch(() => undefined);
    this.stream = undefined;
    this.ctx = undefined;
    this.node = undefined;
  }

  get active() {
    return !!this.stream && this.stream.getAudioTracks().some((t) => t.readyState === "live");
  }
}

export async function listInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
}
