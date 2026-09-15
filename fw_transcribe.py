#!/usr/bin/env python3
"""Transcribe audio with faster-whisper (VAD-filtered) and emit txt/srt/vtt.

Usage:
    fw_transcribe.py <audio_input> <output_prefix>

Writes <output_prefix>.txt, <output_prefix>.srt and <output_prefix>.vtt.
"""

import sys
import time

from faster_whisper import WhisperModel


def format_timestamp(seconds, sep=","):
    """Format seconds as HH:MM:SS<sep>mmm (sep is ',' for SRT, '.' for VTT)."""
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    hours, rem = divmod(total_ms, 3600 * 1000)
    minutes, rem = divmod(rem, 60 * 1000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{millis:03d}"


def write_txt(path, segments):
    with open(path, "w", encoding="utf-8") as fh:
        for segment in segments:
            fh.write(segment["text"].strip() + "\n")


def write_srt(path, segments):
    with open(path, "w", encoding="utf-8") as fh:
        for index, segment in enumerate(segments, start=1):
            start = format_timestamp(segment["start"], ",")
            end = format_timestamp(segment["end"], ",")
            fh.write(f"{index}\n{start} --> {end}\n{segment['text'].strip()}\n\n")


def write_vtt(path, segments):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("WEBVTT\n\n")
        for segment in segments:
            start = format_timestamp(segment["start"], ".")
            end = format_timestamp(segment["end"], ".")
            fh.write(f"{start} --> {end}\n{segment['text'].strip()}\n\n")


def main(argv):
    if len(argv) != 3:
        print(f"usage: {argv[0]} <audio_input> <output_prefix>", file=sys.stderr)
        return 2

    audio_path, output_prefix = argv[1], argv[2]

    model = WhisperModel("large-v3", device="cpu", compute_type="int8")

    started = time.time()
    raw_segments, info = model.transcribe(
        audio_path,
        language="es",
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
        condition_on_previous_text=False,
        beam_size=5,
    )

    segments = []
    for segment in raw_segments:
        segments.append(
            {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
            }
        )

    elapsed = time.time() - started

    write_txt(output_prefix + ".txt", segments)
    write_srt(output_prefix + ".srt", segments)
    write_vtt(output_prefix + ".vtt", segments)

    total_duration = segments[-1]["end"] if segments else 0.0

    print(f"segments: {len(segments)}")
    print(f"duration: {total_duration:.3f}s")
    print(f"compute: {elapsed:.3f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
