interface RefuelingVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  target: number;
}

const REFUELING_VOLUME = 0.6;
const REFUELING_FADE_TIME = 0.12;
const GASOLINE_SALE_VOLUME = 0.7;
const CANISTER_PICKUP_VOLUME = 0.7;

/** WebAudio-эффекты игры: синтезатор и зацикленные записи заправки. */
class Sfx {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private engOsc: OscillatorNode | null = null;
  private engOsc2: OscillatorNode | null = null;
  private engGain: GainNode | null = null;
  private engFilter: BiquadFilterNode | null = null;
  private engineOn = false;
  muted = false;
  private wasMutedByBlur = false;
  private listenersAttached = false;
  private refuelingBuffers: AudioBuffer[] = [];
  private refuelingLoadAttempted = false;
  private refuelingLoad: Promise<void> | null = null;
  private refuelingTargets = new Map<string, number>();
  private refuelingVoices = new Map<string, RefuelingVoice>();
  private readonly refuelingFiles = [
    new URL("../sound/effects/refueling/Refueling1.mp3", import.meta.url).href,
    new URL("../sound/effects/refueling/Refueling2.mp3", import.meta.url).href,
  ];
  /** одиночные записи: декодированный буфер и незавершённая загрузка на файл */
  private samples = new Map<string, AudioBuffer>();
  private sampleLoads = new Map<string, Promise<void>>();
  private readonly saleFile = new URL("../sound/effects/gasoline_sales.mp3", import.meta.url).href;
  private readonly canisterPickupFile = new URL(
    "../sound/effects/obtaining_an_empty_canister.mp3",
    import.meta.url
  ).href;

  init(): void {
    if (this.ensureContext()) {
      this.loadRefuelingBuffers();
      void this.loadSample(this.saleFile);
      void this.loadSample(this.canisterPickupFile);
    }

    if (this.listenersAttached) return;
    this.listenersAttached = true;

    // Слушаем потерю/восстановление фокуса вкладки
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.handleBlur();
      } else {
        this.handleFocus();
      }
    });

    window.addEventListener("blur", () => this.handleBlur());
    window.addEventListener("focus", () => this.handleFocus());
  }

  /**
   * Создаёт общий AudioContext (его же использует музыка) и будит его —
   * браузер разрешает запуск только из обработчика жеста игрока.
   */
  ensureContext(): AudioContext | null {
    try {
      if (!this.ac) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ac = new AC();
        this.master = this.ac.createGain();
        this.master.gain.value = this.muted ? 0 : 0.5;
        this.master.connect(this.ac.destination);
      }
      if (this.ac.state === "suspended") void this.ac.resume();
    } catch {
      this.ac = null;
    }
    return this.ac;
  }

  /** Уже созданный контекст — без попытки его открыть. */
  get audioContext(): AudioContext | null {
    return this.ac;
  }

  private handleBlur(): void {
    if (!this.muted && this.ac && this.master) {
      this.wasMutedByBlur = true;
      this.master.gain.setTargetAtTime(0, this.ac.currentTime, 0.05);
    }
  }

  private handleFocus(): void {
    if (this.wasMutedByBlur && !this.muted && this.ac && this.master) {
      this.wasMutedByBlur = false;
      this.master.gain.setTargetAtTime(0.5, this.ac.currentTime, 0.05);
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ac) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ac.currentTime, 0.05);
    }
  }

  /** завести мотор */
  engineStart(): void {
    if (!this.ac || !this.master || this.engineOn) return;
    try {
      this.engOsc = this.ac.createOscillator();
      this.engOsc.type = "sawtooth";
      this.engOsc.frequency.value = 58;
      this.engOsc2 = this.ac.createOscillator();
      this.engOsc2.type = "square";
      this.engOsc2.frequency.value = 29;
      this.engFilter = this.ac.createBiquadFilter();
      this.engFilter.type = "lowpass";
      this.engFilter.frequency.value = 420;
      this.engGain = this.ac.createGain();
      this.engGain.gain.value = 0;
      this.engOsc.connect(this.engFilter);
      this.engOsc2.connect(this.engFilter);
      this.engFilter.connect(this.engGain);
      this.engGain.connect(this.master);
      this.engOsc.start();
      this.engOsc2.start();
      this.engineOn = true;
    } catch {
      this.engineOn = false;
    }
  }

  /** каждый кадр: speed01 — скорость 0..1, load01 — газ 0..1 */
  engine(speed01: number, load01: number): void {
    if (!this.ac || !this.engineOn || !this.engOsc || !this.engOsc2 || !this.engGain || !this.engFilter) return;
    const t = this.ac.currentTime;
    this.engOsc.frequency.setTargetAtTime(55 + speed01 * 128, t, 0.07);
    this.engOsc2.frequency.setTargetAtTime(27 + speed01 * 64, t, 0.07);
    this.engFilter.frequency.setTargetAtTime(320 + speed01 * 900, t, 0.09);
    const g = 0.016 + load01 * 0.034 + speed01 * 0.026;
    this.engGain.gain.setTargetAtTime(g, t, 0.12);
  }

  engineIdle(): void {
    if (!this.ac || !this.engineOn || !this.engGain || !this.engOsc || !this.engOsc2) return;
    const t = this.ac.currentTime;
    this.engOsc.frequency.setTargetAtTime(52, t, 0.2);
    this.engOsc2.frequency.setTargetAtTime(26, t, 0.2);
    this.engGain.gain.setTargetAtTime(0.012, t, 0.2);
  }

  /** разблокировка новой заправки */
  unlock(): void {
    this.tone([392, 587, 880], 0.08, "square", 0.085, 0.03);
  }

  /** станция израсходована — закрылась */
  stationLock(): void {
    this.tone([330, 196], 0.11, "square", 0.075, 0);
  }

  /** радостный перезвон при подписании клиента */
  chime(): void {
    this.tone([523, 659, 784, 1046], 0.09, "triangle", 0.16, 0.05);
  }

  win(): void {
    this.tone([392, 523, 659, 784, 1046, 1318], 0.12, "triangle", 0.16, 0.06);
  }

  thud(): void {
    if (!this.ac || !this.master) return;
    try {
      const t = this.ac.currentTime;
      const dur = 0.14;
      const buf = this.ac.createBuffer(1, this.ac.sampleRate * dur, this.ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      const f = this.ac.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 260;
      const g = this.ac.createGain();
      g.gain.setValueAtTime(0.28, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t);
    } catch {
      /* тишина */
    }
  }

  tick(): void {
    this.tone([1180], 0.05, "square", 0.045, 0);
  }

  /** предупреждение: мало топлива */
  warn(): void {
    this.tone([880, 640], 0.15, "square", 0.06, 0);
  }

  /**
   * Синхронизирует зацикленные записи заправки с активными машинами.
   * Значение громкости нормализовано от 0 до 1; отсутствующие ключи плавно
   * затухают и останавливаются. Один ключ сохраняет случайно выбранную запись
   * до конца одной заправки.
   */
  syncRefueling(targets: ReadonlyMap<string, number>): void {
    this.refuelingTargets = new Map(
      [...targets].map(([id, volume]) => [id, Math.max(0, Math.min(1, volume))])
    );
    this.applyRefuelingTargets();
    this.loadRefuelingBuffers();
  }

  stopAllRefueling(): void {
    this.refuelingTargets.clear();
    this.applyRefuelingTargets();
  }

  private loadRefuelingBuffers(): void {
    const ac = this.ac;
    if (!ac || this.refuelingLoadAttempted || this.refuelingLoad) return;
    this.refuelingLoadAttempted = true;

    this.refuelingLoad = Promise.all(
      this.refuelingFiles.map(async (file): Promise<AudioBuffer | null> => {
        try {
          const response = await fetch(file);
          if (!response.ok) return null;
          return await ac.decodeAudioData(await response.arrayBuffer());
        } catch {
          return null;
        }
      })
    )
      .then((buffers) => {
        if (this.ac !== ac) return;
        this.refuelingBuffers = buffers.filter((buffer): buffer is AudioBuffer => buffer !== null);
        this.applyRefuelingTargets();
      })
      .finally(() => {
        this.refuelingLoad = null;
      });
  }

  private applyRefuelingTargets(): void {
    const ac = this.ac;
    const master = this.master;
    if (!ac || !master) return;

    for (const [id, voice] of this.refuelingVoices) {
      const volume = this.refuelingTargets.get(id);
      if (volume === undefined) {
        this.stopRefuelingVoice(id, voice);
        continue;
      }
      const target = volume * REFUELING_VOLUME;
      if (Math.abs(voice.target - target) < 0.002) continue;
      voice.target = target;
      voice.gain.gain.cancelScheduledValues(ac.currentTime);
      voice.gain.gain.setTargetAtTime(target, ac.currentTime, REFUELING_FADE_TIME);
    }

    if (this.refuelingBuffers.length === 0) return;
    for (const [id, volume] of this.refuelingTargets) {
      if (this.refuelingVoices.has(id)) continue;
      try {
        const source = ac.createBufferSource();
        source.buffer =
          this.refuelingBuffers[Math.floor(Math.random() * this.refuelingBuffers.length)];
        source.loop = true;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0, ac.currentTime);
        gain.gain.setTargetAtTime(
          volume * REFUELING_VOLUME,
          ac.currentTime,
          REFUELING_FADE_TIME
        );
        source.connect(gain);
        gain.connect(master);

        const voice = { source, gain, target: volume * REFUELING_VOLUME };
        this.refuelingVoices.set(id, voice);
        source.onended = () => {
          if (this.refuelingVoices.get(id) === voice) this.refuelingVoices.delete(id);
          source.disconnect();
          gain.disconnect();
        };
        source.start();
      } catch {
        /* тишина */
      }
    }
  }

  private stopRefuelingVoice(id: string, voice: RefuelingVoice): void {
    const ac = this.ac;
    this.refuelingVoices.delete(id);
    if (!ac) return;
    try {
      voice.target = 0;
      voice.gain.gain.cancelScheduledValues(ac.currentTime);
      voice.gain.gain.setTargetAtTime(0, ac.currentTime, REFUELING_FADE_TIME / 2);
      voice.source.stop(ac.currentTime + REFUELING_FADE_TIME * 2);
    } catch {
      voice.source.disconnect();
      voice.gain.disconnect();
    }
  }

  /** игрок слил бензин на базе — запись кассы приёмщика */
  gasolineSale(): void {
    this.playSample(this.saleFile, GASOLINE_SALE_VOLUME);
  }

  /** игрок подобрал канистру с карты */
  canisterPickup(): void {
    this.playSample(this.canisterPickupFile, CANISTER_PICKUP_VOLUME);
  }

  private playSample(file: string, volume: number): void {
    if (!this.ac) return;
    if (this.samples.has(file)) {
      this.playSampleBuffer(file, volume);
      return;
    }
    // Первое срабатывание может прийтись на ещё не загруженную запись:
    // доигрываем её, как только декодирование закончится.
    const ac = this.ac;
    void this.loadSample(file).then(() => {
      if (this.ac === ac) this.playSampleBuffer(file, volume);
    });
  }

  private loadSample(file: string): Promise<void> {
    const ac = this.ac;
    if (!ac || this.samples.has(file)) return Promise.resolve();
    const pending = this.sampleLoads.get(file);
    if (pending) return pending;

    const load = (async () => {
      try {
        const response = await fetch(file);
        if (!response.ok) return;
        const buffer = await ac.decodeAudioData(await response.arrayBuffer());
        if (this.ac === ac) this.samples.set(file, buffer);
      } catch {
        /* тишина */
      }
    })().finally(() => {
      this.sampleLoads.delete(file);
    });

    this.sampleLoads.set(file, load);
    return load;
  }

  private playSampleBuffer(file: string, volume: number): void {
    const ac = this.ac;
    const master = this.master;
    const buffer = this.samples.get(file);
    if (!ac || !master || !buffer) return;
    try {
      const source = ac.createBufferSource();
      source.buffer = buffer;
      const gain = ac.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(master);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
      source.start();
    } catch {
      /* тишина */
    }
  }

  /** бак полон */
  tankFull(): void {
    this.tone([660, 880, 1320], 0.08, "triangle", 0.13, 0.03);
  }

  /** мотор заглох */
  stall(): void {
    if (!this.ac || !this.master) return;
    try {
      const t = this.ac.currentTime;
      const osc = this.ac.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(130, t);
      osc.frequency.exponentialRampToValueAtTime(26, t + 0.7);
      const g = this.ac.createGain();
      g.gain.setValueAtTime(0.17, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.78);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.85);
    } catch {
      /* тишина */
    }
  }

  private tone(freqs: number[], step: number, type: OscillatorType, vol: number, offset: number): void {
    if (!this.ac || !this.master) return;
    try {
      const t0 = this.ac.currentTime + offset;
      freqs.forEach((fr, i) => {
        const t = t0 + i * step;
        const osc = this.ac!.createOscillator();
        osc.type = type;
        osc.frequency.value = fr;
        const g = this.ac!.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0008, t + 0.34);
        osc.connect(g);
        g.connect(this.master!);
        osc.start(t);
        osc.stop(t + 0.4);
      });
    } catch {
      /* тишина */
    }
  }
}

export const sfx = new Sfx();
