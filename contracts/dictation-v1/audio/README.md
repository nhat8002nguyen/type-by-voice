# Audio fixtures

Opus-in-Ogg files for contract tests. Regenerated with:

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ar 16000 -ac 1 -c:a libopus -b:a 24k -vbr off -frame_duration 20 contracts/dictation-v1/audio/speech-1s.ogg
ffmpeg -f lavfi -i "anullsrc=r=16000:cl=mono" -t 0.4 -c:a libopus -b:a 24k -vbr off -frame_duration 20 contracts/dictation-v1/audio/silence-400ms.ogg
```

`speech-1s.ogg` is a 440 Hz tone, not speech. Encode a real clip into `audio/local/` (gitignored) and pass it as `HARNESS_AUDIO`:

```bash
ffmpeg -i ~/Desktop/your-speech.mp3 \
  -ar 16000 -ac 1 -c:a libopus -b:a 24k -vbr off -frame_duration 20 \
  contracts/dictation-v1/audio/local/speech.ogg
```
