# Audio fixtures

Opus-in-Ogg files for contract tests. Regenerated with:

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ar 16000 -ac 1 -c:a libopus -b:a 24k -vbr off -frame_duration 20 contracts/dictation-v1/audio/speech-1s.ogg
ffmpeg -f lavfi -i "anullsrc=r=16000:cl=mono" -t 0.4 -c:a libopus -b:a 24k -vbr off -frame_duration 20 contracts/dictation-v1/audio/silence-400ms.ogg
```
