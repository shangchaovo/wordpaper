"""Write matching audio and real WordBoundary timings using the existing Edge runtime."""
import asyncio
import html
import json
import sys
import edge_tts


async def main():
    voice, rate, text, audio_path, metadata_path = sys.argv[1:]
    cues = []
    # CLI subtitle output defaults to SentenceBoundary in newer edge-tts.
    # Request word events explicitly; never estimate word durations from text.
    stream = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    with open(audio_path, "wb") as audio:
        async for chunk in stream.stream():
            if chunk["type"] == "audio":
                audio.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                cues.append({"text": html.unescape(chunk["text"]),
                             "start": chunk["offset"] / 10000000,
                             "end": (chunk["offset"] + chunk["duration"]) / 10000000})
    with open(metadata_path, "w", encoding="utf-8") as metadata:
        json.dump({"cues": cues}, metadata, ensure_ascii=False)


if __name__ == "__main__":
    asyncio.run(main())
