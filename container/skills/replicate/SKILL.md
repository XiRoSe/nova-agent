# Skill: Replicate (Multimodal AI)

## Description
Access 9,000+ AI models on demand via Replicate — image generation, vision analysis, audio processing, video understanding, and more.

## When to Use
- User asks to generate an image, logo, or visual
- User sends an image and asks to analyze it
- User needs audio transcription beyond Whisper
- User wants video analysis or generation
- Any task requiring multimodal AI capabilities

## Setup
Install: `npm install replicate`

## Implementation
```typescript
import Replicate from 'replicate';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

// Image generation
async function generateImage(prompt: string) {
  const output = await replicate.run('black-forest-labs/flux-1.1-pro', {
    input: { prompt, aspect_ratio: '16:9' }
  });
  return output; // Returns URL(s)
}

// Vision analysis (describe/analyze an image)
async function analyzeImage(imageUrl: string, question: string) {
  const output = await replicate.run('meta/llama-4-maverick-instruct', {
    input: { image: imageUrl, prompt: question }
  });
  return output;
}

// Speech to text (alternative to Whisper, more languages)
async function transcribeAudio(audioUrl: string) {
  const output = await replicate.run('openai/whisper', {
    input: { audio: audioUrl }
  });
  return output;
}

// Image upscaling
async function upscaleImage(imageUrl: string) {
  const output = await replicate.run('nightmareai/real-esrgan', {
    input: { image: imageUrl, scale: 4 }
  });
  return output;
}

// Background removal
async function removeBackground(imageUrl: string) {
  const output = await replicate.run('cjwbw/rembg', {
    input: { image: imageUrl }
  });
  return output;
}

// Video generation
async function generateVideo(prompt: string) {
  const output = await replicate.run('minimax/video-01-live', {
    input: { prompt }
  });
  return output;
}
```

## Cost Awareness
Before running any Replicate model, estimate cost:
- Image generation: ~$0.01-0.05 per image
- Vision analysis: ~$0.01 per image
- Audio transcription: ~$0.01 per minute
- Video generation: ~$0.10-1.00 per video

If estimated cost > $0.50 for a single operation, inform the user before proceeding.

## Common Use Cases
| Task | Model |
|---|---|
| Generate images | flux-1.1-pro, sdxl |
| Analyze images | llama-4-maverick-instruct |
| Transcribe audio | openai/whisper |
| Generate video | minimax/video-01-live |
| Remove background | cjwbw/rembg |
| Upscale images | nightmareai/real-esrgan |
| OCR (read text from images) | meta/llama-4-maverick-instruct |

## Notes
- Always cache results to avoid duplicate API calls
- For batch operations, process in parallel when possible
- Store generated images in /home/nova/data/generated/
