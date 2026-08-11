class KoePCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const copyLength = Math.min(channel.length - sourceOffset, this.buffer.length - this.offset);
      this.buffer.set(channel.subarray(sourceOffset, sourceOffset + copyLength), this.offset);
      this.offset += copyLength;
      sourceOffset += copyLength;
      if (this.offset === this.buffer.length) {
        const output = this.buffer;
        this.port.postMessage(output.buffer, [output.buffer]);
        this.buffer = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("koe-pcm-capture", KoePCMProcessor);
