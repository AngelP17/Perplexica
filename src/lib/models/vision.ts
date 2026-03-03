const visionModelPattern =
  /(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|vision|vl|llava|bakllava|moondream|minicpm-v|qwen2(\.5)?-vl|phi-3\.5-vision|llama3\.2-vision|gemma3)/i;

export const isVisionModelKey = (modelKey: string) => {
  return visionModelPattern.test(modelKey);
};

export const getImageMimeType = (imagePath: string) => {
  const normalized = imagePath.toLowerCase();

  if (normalized.endsWith('.png')) {
    return 'image/png';
  }

  if (normalized.endsWith('.webp')) {
    return 'image/webp';
  }

  if (normalized.endsWith('.gif')) {
    return 'image/gif';
  }

  return 'image/jpeg';
};
