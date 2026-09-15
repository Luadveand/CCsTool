#!/usr/bin/env python3
"""Transcribe audio with faster-whisper (VAD-filtered) and emit txt/srt/vtt/words.json.

Usage:
    fw_transcribe.py <audio_input> <output_prefix>

Writes <output_prefix>.txt, <output_prefix>.srt, <output_prefix>.vtt and
<output_prefix>_words.json (per-word timestamps + segment confidence).
"""

import json
import os
import subprocess
import sys
import time

from faster_whisper import WhisperModel


def probe_duration(path):
    """Real audio duration in seconds via ffprobe."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def write_words_json(path, audio_path, language, segments):
    data = {
        "audio": os.path.basename(audio_path),
        "duration": probe_duration(audio_path),
        "language": language,
        "segments": segments,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
        fh.write("\n")


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
        word_timestamps=True,
    )

    segments = []
    for index, segment in enumerate(raw_segments, start=1):
        segments.append(
            {
                "id": index,
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
                "avg_logprob": segment.avg_logprob,
                "no_speech_prob": segment.no_speech_prob,
                "compression_ratio": segment.compression_ratio,
                "words": [
                    {"w": w.word, "s": w.start, "e": w.end, "p": w.probability}
                    for w in (segment.words or [])
                ],
            }
        )

    elapsed = time.time() - started

    write_txt(output_prefix + ".txt", segments)
    write_srt(output_prefix + ".srt", segments)
    write_vtt(output_prefix + ".vtt", segments)
    write_words_json(output_prefix + "_words.json", audio_path, info.language, segments)

    total_duration = probe_duration(audio_path)

    print(f"segments: {len(segments)}")
    print(f"duration: {total_duration:.3f}s")
    print(f"compute: {elapsed:.3f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
