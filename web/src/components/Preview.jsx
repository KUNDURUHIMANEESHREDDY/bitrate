import { useMemo, useState } from 'react';
import {
  FilmStrip, MusicNotes, DownloadSimple, SpinnerGap, Warning, Clock,
} from '@phosphor-icons/react';
import { Button, Field, Select, Checkbox, Segmented, Tag, Skeleton } from './ui.jsx';
import { bytes, duration, extractorName } from '../lib/format.js';

const HEIGHT_STEPS = [2160, 1440, 1080, 720, 480, 360];

/**
 * Format picker.
 *
 * Defaults to the highest available quality and audio passthrough, because
 * that is the fast path. Converting to mp3 or remuxing to mp4 is opt-in and
 * labelled as costing time, so the default stays honest about what it costs.
 */
export default function Preview({ info, onStart, onReset, starting }) {
  const [kind, setKind] = useState('video');
  const [quality, setQuality] = useState('best');
  const [audioFormat, setAudioFormat] = useState('best');
  const [subtitle, setSubtitle] = useState(false);
  const [remuxMp4, setRemuxMp4] = useState(false);

  const hasAudio = useMemo(
    () => info.formats.some((f) => f.hasAudio),
    [info.formats],
  );
  const hasVideo = useMemo(
    () => info.formats.some((f) => f.hasVideo),
    [info.formats],
  );

  /**
   * An MP4 container can only carry a handful of video codecs. Offering the
   * remux on a VP8/VP9-only source just guarantees a failed post-process, so
   * the option is hidden and the reason is shown instead.
   */
  const mp4Safe = useMemo(() => {
    const MP4_CODECS = /^(avc1|avc3|h264|hevc|h265|hev1|av01|av1|mp4v|mpeg4|vp09[. ]?)/i;
    return info.formats
      .filter((f) => f.hasVideo && f.vcodec)
      .some((f) => MP4_CODECS.test(f.vcodec));
  }, [info.formats]);

  const videoCodecs = useMemo(() => {
    const set = new Set(
      info.formats.filter((f) => f.hasVideo && f.vcodec).map((f) => f.vcodec),
    );
    return [...set].slice(0, 3);
  }, [info.formats]);

  const available = useMemo(() => {
    const heights = new Set(
      info.formats.filter((f) => f.hasVideo && f.height).map((f) => f.height),
    );
    return HEIGHT_STEPS.filter((h) => heights.has(h));
  }, [info.formats]);

  const bestVideo = useMemo(() => {
    const vids = info.formats.filter((f) => f.hasVideo);
    if (!vids.length) return null;
    return vids.reduce((a, b) => ((b.height || 0) > (a.height || 0) ? b : a));
  }, [info.formats]);

  const estimate = useMemo(() => {
    if (kind === 'audio') {
      const a = info.formats.filter((f) => f.hasAudio);
      const best = a.reduce((x, y) => ((y.tbr || 0) > (x.tbr || 0) ? y : x), a[0]);
      return best?.filesize ? bytes(best.filesize) : null;
    }
    if (quality === 'best') return bestVideo?.filesize ? bytes(bestVideo.filesize) : null;
    const h = Number(quality);
    const match = info.formats.filter((f) => f.hasVideo && f.height === h);
    const pick = match.length ? match.reduce((a, b) => ((b.tbr || 0) > (a.tbr || 0) ? b : a)) : null;
    return pick?.filesize ? bytes(pick.filesize) : null;
  }, [kind, quality, info.formats, bestVideo]);

  const switchKind = (next) => {
    setKind(next);
    if (next === 'audio') setSubtitle(false);
  };

  const submit = () =>
    onStart({
      url: info.webpageUrl || info.url,
      kind,
      quality,
      audioFormat,
      subtitle,
      remuxMp4: kind === 'video' && remuxMp4,
      title: info.title,
    });

  return (
    <section
      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
      aria-label="Link details"
    >
      <div className="flex flex-col sm:flex-row">
        <div className="relative w-full sm:w-56 shrink-0 bg-[var(--surface-sunken)] aspect-video sm:aspect-auto">
          {info.thumbnail ? (
            <img
              src={info.thumbnail}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <FilmStrip size={26} className="text-[var(--text-subtle)]" />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 p-4 flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h2 className="text-[15px] font-semibold leading-snug text-[var(--text)] break-words">
                {info.title || 'Untitled'}
              </h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--text-muted)]">
                {info.uploader ? <span className="truncate max-w-[24ch]">{info.uploader}</span> : null}
                {info.uploader && duration(info.duration) ? (
                  <span className="text-[var(--text-subtle)]" aria-hidden="true">/</span>
                ) : null}
                {duration(info.duration) ? (
                  <span className="inline-flex items-center gap-1 font-mono">
                    <Clock size={12} weight="bold" />
                    {duration(info.duration)}
                  </span>
                ) : null}
                {extractorName(info.extractor) ? <Tag>{extractorName(info.extractor)}</Tag> : null}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={onReset}>
              Clear
            </Button>
          </div>

          <hr className="border-[var(--border)]" />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type" htmlFor="kind-group">
              <Segmented
                label="Type"
                value={kind}
                onChange={switchKind}
                options={[
                  ...(hasVideo ? [{ value: 'video', label: 'Video' }] : []),
                  ...(hasAudio ? [{ value: 'audio', label: 'Audio' }] : []),
                ]}
              />
            </Field>

            {kind === 'video' ? (
              <Field label="Quality" htmlFor="quality-select">
                <Select
                  id="quality-select"
                  value={quality}
                  onChange={(e) => setQuality(e.target.value)}
                >
                  <option value="best">Best available</option>
                  {available.map((h) => (
                    <option key={h} value={h}>{h}p</option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field
                label="Audio format"
                htmlFor="audio-select"
                hint="Original is the source stream, copied with no re-encode."
              >
                <Select
                  id="audio-select"
                  value={audioFormat}
                  onChange={(e) => setAudioFormat(e.target.value)}
                >
                  <option value="best">Original (no conversion)</option>
                  <option value="m4a">M4A (converted)</option>
                  <option value="mp3">MP3 (converted, slower)</option>
                </Select>
              </Field>
            )}
          </div>

          {kind === 'video' ? (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {mp4Safe ? (
                <Checkbox
                  id="opt-remux"
                  checked={remuxMp4}
                  onChange={setRemuxMp4}
                  label="Force MP4 container"
                  hint="Stream copy into mp4. No re-encode, but it rewrites the container."
                />
              ) : (
                <div className="flex items-start gap-2.5">
                  <Warning size={15} weight="bold" className="mt-0.5 shrink-0 text-[var(--text-subtle)]" aria-hidden="true" />
                  <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
                    {videoCodecs.length ? videoCodecs.join(', ') : 'This codec'} cannot be stored
                    in an MP4 container without re-encoding, so the original format is kept.
                  </p>
                </div>
              )}
              <Checkbox
                id="opt-subs"
                checked={subtitle}
                onChange={setSubtitle}
                label="Save English subtitles"
                hint="Embedded captions, exported as srt."
              />
            </div>
          ) : null}

          {audioFormat === 'mp3' || (kind === 'audio' && audioFormat === 'm4a') ? (
            <p className="flex items-start gap-2 text-[12px] text-[var(--warning)]">
              <Warning size={14} weight="bold" className="mt-px shrink-0" />
              <span>
                Converting re-encodes the audio, so it takes real CPU time. Original is faster and
                lossless.
              </span>
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 pt-0.5">
            <Button
              variant="primary"
              onClick={submit}
              disabled={starting}
              className="min-w-[150px]"
            >
              {starting ? (
                <>
                  <SpinnerGap size={16} weight="bold" className="animate-spin" />
                  Starting
                </>
              ) : (
                <>
                  {kind === 'audio' ? <MusicNotes size={16} weight="bold" /> : <DownloadSimple size={16} weight="bold" />}
                  Download
                </>
              )}
            </Button>
            {estimate ? (
              <span className="text-[12px] text-[var(--text-muted)] font-mono">
                about {estimate}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export function PreviewSkeleton() {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      <div className="flex gap-4">
        <Skeleton className="w-40 h-24 shrink-0" />
        <div className="flex-1 flex flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-9 w-full" />
    </div>
  );
}
