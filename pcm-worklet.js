class KoePcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(2_048);
    this.pendingLength = 0;
  }

  process(inputs) {
    const channel = inputs?.[0]?.[0];
    if (!channel?.length) return true;
    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const count = Math.min(channel.length - sourceOffset, this.pending.length - this.pendingLength);
      this.pending.set(channel.subarray(sourceOffset, sourceOffset + count), this.pendingLength);
      this.pendingLength += count;
      sourceOffset += count;
      if (this.pendingLength === this.pending.length) {
        const block = this.pending;
        this.port.postMessage(block, [block.buffer]);
        this.pending = new Float32Array(2_048);
        this.pendingLength = 0;
      }
    }
    return true;
  }
}

registerProcessor("koe-pcm-capture", KoePcmCaptureProcessor);
