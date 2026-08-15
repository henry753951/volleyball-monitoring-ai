# ADR-0002: Server-resolved media time is authoritative

The browser sends a PlaybackCursor containing playback-window ID, mapping version, and presented media time. The server resolves it to source PTS/time/frame. Browser wall clock and `currentTime * fps` are never authoritative.
