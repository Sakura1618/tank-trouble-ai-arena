import { MatchReplay } from '../src/arena/replay.js';
import { ArenaRenderer } from '../src/arena/render.js';

const WIDTH = 1280, HEIGHT = 720, FPS = 30;

export function supportedMp4Type() {
  if (!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
  return ['video/mp4;codecs=avc1.42E01F', 'video/mp4;codecs=avc1', 'video/mp4']
    .find(type => MediaRecorder.isTypeSupported(type)) ?? null;
}

// 独立回放对象只读取录像状态；录制速度不受界面上的播放、暂停或拖动影响。
// MediaRecorder 使用真实时间，标签页隐藏时同时暂停编码与录像时钟。
export function exportRecordingMp4(record, { mimeType, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none';
    document.body.append(canvas);
    const replay = new MatchReplay(record);
    const renderer = new ArenaRenderer(canvas, { maxDpr: 1 });
    const duration = replay.totalTicks / record.physicsHz;
    const chunks = [];
    let stream, recorder, animation, startedAt, pausedAt, lastFrame = -1, failure;

    const draw = seconds => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1);
      canvas.style.width = `${WIDTH / dpr}px`;
      canvas.style.height = `${HEIGHT / dpr}px`;
      replay.seek(Math.min(replay.totalTicks, seconds * record.physicsHz));
      replay.world.actors.forEach(actor => { actor.name = ''; });
      renderer.recordedEffects(replay.world, replay.recentEvents(2), replay.time);
      renderer.draw(replay.world, 0, true);
      const ctx = renderer.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#09111c';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.restore();
    };
    const cleanup = () => {
      cancelAnimationFrame(animation);
      signal.removeEventListener('abort', cancel);
      document.removeEventListener('visibilitychange', visibilityChanged);
      stream?.getTracks().forEach(track => track.stop());
      canvas.remove();
      canvas.width = canvas.height = 0;
    };
    const stop = () => {
      cancelAnimationFrame(animation);
      if (recorder.state !== 'inactive') recorder.stop();
    };
    const cancel = () => stop();
    const frame = now => {
      const seconds = (now - startedAt) / 1000;
      const frameIndex = Math.floor(seconds * FPS);
      if (frameIndex !== lastFrame) {
        lastFrame = frameIndex;
        draw(frameIndex / FPS);
        onProgress(Math.min(1, seconds / duration), false);
      }
      // 给最后一个状态保留一帧，避免末尾的死亡画面未被编码。
      if (seconds >= duration + 1 / FPS) stop();
      else animation = requestAnimationFrame(frame);
    };
    const visibilityChanged = () => {
      if (document.hidden && recorder.state === 'recording') {
        pausedAt = performance.now();
        recorder.pause();
        cancelAnimationFrame(animation);
        onProgress(Math.min(1, (pausedAt - startedAt) / 1000 / duration), true);
      } else if (!document.hidden && recorder.state === 'paused') {
        const now = performance.now();
        startedAt += now - pausedAt;
        recorder.resume();
        animation = requestAnimationFrame(frame);
      }
    };

    try {
      draw(0);
      stream = canvas.captureStream(FPS);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_000_000 });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => { failure = event.error; stop(); };
      recorder.onstop = () => {
        cleanup();
        if (failure) reject(failure);
        else resolve(signal.aborted ? null : new Blob(chunks, { type: recorder.mimeType }));
        chunks.length = 0;
      };
      recorder.onstart = () => {
        startedAt = performance.now();
        animation = requestAnimationFrame(frame);
        if (document.hidden) visibilityChanged();
      };
      signal.addEventListener('abort', cancel, { once: true });
      document.addEventListener('visibilitychange', visibilityChanged);
      recorder.start();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
