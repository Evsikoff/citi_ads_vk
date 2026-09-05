import { sfx } from "./audio";

/**
 * Фоновая музыка игры. Треки декодируются в WebAudio и звучат через тот же
 * AudioContext, что и эффекты: системный плеер браузера (<audio>) не создаётся,
 * поэтому у вкладки нет ни его элементов управления, ни медиасессии ОС.
 */

const MUSIC_VOLUME = 0.3;
const FADE_TIME = 0.5;

const trackModules = import.meta.glob("../sound/music/*.mp3", {
  eager: true,
  import: "default",
}) as Record<string, string>;

/** Порядок треков фиксирован (по имени файла) — случаен только первый из них. */
const TRACKS = Object.keys(trackModules)
  .sort()
  .map((path) => trackModules[path]);

class Music {
  private enabled = true;
  /** Намерение играть: держится между треками, пока музыку не выключили. */
  private playing = false;
  private index = -1;
  /** Растёт при каждой смене трека — по нему отсекаем ответы прошлых загрузок. */
  private token = 0;
  private failures = 0;
  private gain: GainNode | null = null;
  private gainContext: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private encoded = new Map<string, ArrayBuffer>();
  private encodedLoads = new Map<string, Promise<ArrayBuffer | null>>();
  private listenersAttached = false;
  private duckedByBlur = false;

  get isEnabled(): boolean {
    return this.enabled;
  }

  get hasTracks(): boolean {
    return TRACKS.length > 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.play();
    else this.stop();
  }

  /**
   * Запускает случайный трек. Если музыка уже звучит — не перебивает её,
   * дальше плейлист идёт по кругу от выбранного трека.
   */
  play(): void {
    if (!this.enabled || this.playing || TRACKS.length === 0) return;
    this.playing = true;
    this.failures = 0;
    this.index = Math.floor(Math.random() * TRACKS.length);
    void this.playCurrent();
  }

  stop(): void {
    this.playing = false;
    this.token++;
    const source = this.source;
    this.source = null;
    const ac = sfx.audioContext;
    if (!ac) return;
    if (this.gain) {
      this.gain.gain.cancelScheduledValues(ac.currentTime);
      this.gain.gain.setTargetAtTime(0, ac.currentTime, FADE_TIME / 3);
    }
    if (!source) return;
    try {
      source.stop(ac.currentTime + FADE_TIME);
    } catch {
      source.disconnect();
    }
  }

  private async playCurrent(): Promise<void> {
    const ac = sfx.ensureContext();
    if (!ac || !this.playing) return;
    const token = ++this.token;
    const url = TRACKS[this.index];

    const buffer = await this.decode(ac, url);
    if (token !== this.token || !this.playing || sfx.audioContext !== ac) return;

    if (!buffer) {
      // Битый или недоступный файл пропускаем, но не крутим плейлист вхолостую.
      this.failures++;
      if (this.failures >= TRACKS.length) {
        this.playing = false;
        return;
      }
      this.index = (this.index + 1) % TRACKS.length;
      void this.playCurrent();
      return;
    }

    this.failures = 0;
    try {
      const gain = this.ensureGain(ac);
      const source = ac.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      gain.gain.cancelScheduledValues(ac.currentTime);
      gain.gain.setTargetAtTime(this.targetVolume(), ac.currentTime, FADE_TIME / 3);
      source.onended = () => {
        source.disconnect();
        if (token !== this.token || !this.playing) return;
        this.source = null;
        this.index = (this.index + 1) % TRACKS.length;
        void this.playCurrent();
      };
      source.start();
      this.source = source;
      // Следующий трек тянем заранее — к его началу останется только декод.
      void this.loadEncoded(TRACKS[(this.index + 1) % TRACKS.length]);
    } catch {
      this.playing = false;
    }
  }

  private ensureGain(ac: AudioContext): GainNode {
    if (!this.gain || this.gainContext !== ac) {
      this.gain = ac.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(ac.destination);
      this.gainContext = ac;
    }
    this.attachListeners();
    return this.gain;
  }

  /** Пока вкладка скрыта, музыка приглушена — как и эффекты. */
  private attachListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.handleBlur();
      else this.handleFocus();
    });
    window.addEventListener("blur", () => this.handleBlur());
    window.addEventListener("focus", () => this.handleFocus());
  }

  private handleBlur(): void {
    const ac = sfx.audioContext;
    if (!this.gain || !ac || this.duckedByBlur) return;
    this.duckedByBlur = true;
    this.gain.gain.setTargetAtTime(0, ac.currentTime, 0.05);
  }

  private handleFocus(): void {
    const ac = sfx.audioContext;
    if (!this.gain || !ac || !this.duckedByBlur) return;
    this.duckedByBlur = false;
    this.gain.gain.setTargetAtTime(this.targetVolume(), ac.currentTime, 0.05);
  }

  private targetVolume(): number {
    return this.enabled && !this.duckedByBlur ? MUSIC_VOLUME : 0;
  }

  private async decode(ac: AudioContext, url: string): Promise<AudioBuffer | null> {
    const encoded = await this.loadEncoded(url);
    if (!encoded) return null;
    try {
      // decodeAudioData забирает переданный буфер себе, поэтому отдаём копию:
      // исходные байты остаются в кеше для следующего круга плейлиста.
      return await ac.decodeAudioData(encoded.slice(0));
    } catch {
      return null;
    }
  }

  /** Кешируем именно mp3-байты: распакованные треки заняли бы сотни мегабайт. */
  private loadEncoded(url: string): Promise<ArrayBuffer | null> {
    const ready = this.encoded.get(url);
    if (ready) return Promise.resolve(ready);
    const pending = this.encodedLoads.get(url);
    if (pending) return pending;

    const load = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const bytes = await response.arrayBuffer();
        this.encoded.set(url, bytes);
        return bytes;
      } catch {
        return null;
      }
    })().finally(() => {
      this.encodedLoads.delete(url);
    });

    this.encodedLoads.set(url, load);
    return load;
  }
}

export const music = new Music();
