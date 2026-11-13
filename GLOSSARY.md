# rn-camera

A reusable React Native library (iOS and Android) that uploads a video to a remote destination in chunks while it is still being recorded, so the upload finishes moments after recording stops.

## Language

### Capture

**Recording**:
One continuous capture from start to stop, producing exactly one Recording File and uploaded to exactly one Upload URL.
_Avoid_: Video, capture, session, clip

**Recording File**:
The append-only fragmented MP4 file on the device that holds everything captured for a Recording; it is the source of truth for what gets uploaded.
_Avoid_: Temp file, buffer, local video

**Live Recording**:
The single Recording currently being captured by the camera. At most one exists at a time.
_Avoid_: Active recording, current video

**Finished Recording**:
A Recording whose capture has stopped, whether or not its upload is complete.
_Avoid_: Stopped recording, saved video

**Interrupted Recording**:
A Finished Recording whose capture ended abruptly (app killed or crashed) rather than by a stop; it contains every Fragment completed before the interruption.
_Avoid_: Corrupt recording, partial recording

**Fragment**:
A self-contained unit of encoded media appended to the Recording File by the encoder. Fragments are a recording concept and are unrelated to Chunk boundaries.
_Avoid_: Segment, part

### Upload

**Upload URL**:
A resumable, chunk-accepting upload endpoint that the Host App's own backend creates and hands to the library. The library never creates one itself.
_Avoid_: Endpoint, server, backend

**Upload URL Provider**:
The async function the Host App supplies that returns the Upload URL for a new Recording.
_Avoid_: URL callback, URL getter

**Chunk**:
A contiguous slice of the Recording File sent to the Upload URL in a single request; every Chunk except the last is a multiple of 256 KiB.
_Avoid_: Part, segment, piece

**Committed Offset**:
The number of bytes of the Recording File the Upload URL has confirmed receiving; uploading always resumes from here.
_Avoid_: Progress, uploaded bytes, cursor

**Backlog**:
Bytes written to the Recording File but not yet covered by the Committed Offset.
_Avoid_: Queue, pending data

**Upload Complete**:
The Upload URL has accepted the final Chunk. Says nothing about whether the destination has finished processing the video.
_Avoid_: Done, ready, processed

**Upload Queue**:
The Finished Recordings whose upload is not yet complete. The Live Recording always has upload priority over everything in the Upload Queue.
_Avoid_: Pending uploads, backlog

**Retry Upload**:
Restarting a Recording's upload from byte 0 with a fresh Upload URL. A Committed Offset never carries over to a different Upload URL.
_Avoid_: Resume (which continues the same Upload URL from the Committed Offset)

**Keep Recording File**:
A per-Recording choice, made when recording starts, of whether the Recording File stays on the device after Upload Complete. Defaults to keep.
_Avoid_: Cleanup, auto-delete

**Allow Cellular**:
A per-Recording choice, made when recording starts, of whether the Recording may upload over cellular once it is in the Upload Queue. The Live Recording always uploads on any network. Defaults to allow.
_Avoid_: Wi-Fi only, metered mode

### Integration

**Host App**:
The React Native application that installs this library and supplies Upload URLs.
_Avoid_: Client, consumer app
