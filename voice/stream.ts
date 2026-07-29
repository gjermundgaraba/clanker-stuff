export const frameChunks = (text: string, maxBytes: number): string[] => {
  if (!text || maxBytes <= 0) {
    return [];
  }

  const frames: string[] = [];
  let frame = "";
  let frameBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (frame && frameBytes + characterBytes > maxBytes) {
      frames.push(frame);
      frame = "";
      frameBytes = 0;
    }
    frame += character;
    frameBytes += characterBytes;
  }
  if (frame) {
    frames.push(frame);
  }
  return frames;
};
