This document is a prompt for brainstorming ideas and system architecture to build a production-grade Wispr Flow alternative.

The goal is to build a native macOS application tailored for Mac users.

It should be a streamlined feature delivering blazing-fast speed and high accuracy. Performance and low resource consumption are top priorities, far more important than feature quantity.

The core workflow is straightforward:

1. Press or hold a custom shortcut key (or combination) to start recording audio via the microphone.
2. Stop recording after a few seconds of silence or by pressing the shortcut key again.
3. A fast background local Whisper model (such as `large-v3`) processes the audio and transcribes/translates it into text.
4. Once complete, the system automatically inserts the text at the active cursor position (or copies it to the clipboard).

The background translation and audio processing engines should be bundled together into a standalone, distributable application.