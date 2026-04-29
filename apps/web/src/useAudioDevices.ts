import { useCallback, useEffect, useState } from 'react';

export interface AudioDeviceOption {
  /** deviceId（'' 代表使用浏览器默认） */
  id: string;
  label: string;
}

export interface UseAudioDevicesResult {
  inputs: AudioDeviceOption[];
  outputs: AudioDeviceOption[];
  /** 当前选中的输入设备 deviceId（''=默认） */
  inputId: string;
  /** 当前选中的输出设备 deviceId（''=默认） */
  outputId: string;
  setInputId: (id: string) => void;
  setOutputId: (id: string) => void;
  /**
   * 浏览器是否支持 HTMLMediaElement.setSinkId（输出路由）。
   * Safari/部分 Firefox 不支持；不支持时 outputId 仅作记录用。
   */
  setSinkIdSupported: boolean;
  /** 是否已经获得过麦克风权限（用于决定 enumerateDevices 能否拿到 label） */
  permissionGranted: boolean;
  /** 主动请求麦克风权限以拿到设备真实 label。 */
  requestPermission: () => Promise<void>;
  /** 重新枚举设备（一般 devicechange 事件会自动触发）。 */
  refresh: () => Promise<void>;
}

const LS_INPUT = 'play-ppt:audio:inputId';
const LS_OUTPUT = 'play-ppt:audio:outputId';

function readLs(key: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeLs(key: string, val: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, val);
  } catch {
    /* ignore */
  }
}

/**
 * 列出系统音频输入/输出设备，提供选择并持久化（localStorage）。
 *
 * 关于浏览器限制：
 * - `enumerateDevices()` 在没有授予过 `getUserMedia` 权限时，label 字段会是空字符串。
 *   需要先调一次 `getUserMedia({ audio: true })` 拿到权限，devices 才会带可读名字。
 * - `HTMLAudioElement.setSinkId` 仅 Chromium 系完整支持；Safari/Firefox 大多不支持。
 *   不支持时仍允许选择 outputId，但调用方需要降级到默认输出。
 */
export function useAudioDevices(): UseAudioDevicesResult {
  const [inputs, setInputs] = useState<AudioDeviceOption[]>([]);
  const [outputs, setOutputs] = useState<AudioDeviceOption[]>([]);
  const [inputId, setInputIdState] = useState<string>(() => readLs(LS_INPUT));
  const [outputId, setOutputIdState] = useState<string>(() => readLs(LS_OUTPUT));
  const [permissionGranted, setPermissionGranted] = useState(false);

  const setSinkIdSupported = typeof window !== 'undefined'
    && typeof HTMLAudioElement !== 'undefined'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    && typeof (HTMLAudioElement.prototype as any).setSinkId === 'function';

  const enumerate = useCallback(async (): Promise<void> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const ins: AudioDeviceOption[] = [{ id: '', label: '系统默认（自动）' }];
      const outs: AudioDeviceOption[] = [{ id: '', label: '系统默认（自动）' }];
      let anyLabeled = false;
      for (const d of list) {
        if (d.kind === 'audioinput') {
          ins.push({ id: d.deviceId, label: d.label || `输入设备 ${d.deviceId.slice(0, 6)}` });
          if (d.label) anyLabeled = true;
        } else if (d.kind === 'audiooutput') {
          outs.push({ id: d.deviceId, label: d.label || `输出设备 ${d.deviceId.slice(0, 6)}` });
          if (d.label) anyLabeled = true;
        }
      }
      // 去重（同 id 多次出现）
      const dedup = (arr: AudioDeviceOption[]): AudioDeviceOption[] => {
        const seen = new Set<string>();
        return arr.filter((o) => {
          if (seen.has(o.id)) return false;
          seen.add(o.id);
          return true;
        });
      };
      setInputs(dedup(ins));
      setOutputs(dedup(outs));
      if (anyLabeled) setPermissionGranted(true);
    } catch {
      /* ignore */
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<void> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      setPermissionGranted(true);
      // 立即停止采集，仅借机拿到 label。
      s.getTracks().forEach((t) => t.stop());
      await enumerate();
    } catch {
      /* ignore */
    }
  }, [enumerate]);

  useEffect(() => {
    void enumerate();
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    const handler = () => { void enumerate(); };
    navigator.mediaDevices.addEventListener?.('devicechange', handler);
    return () => {
      navigator.mediaDevices.removeEventListener?.('devicechange', handler);
    };
  }, [enumerate]);

  // 拔出选中设备时回退到默认（避免 getUserMedia 一直拿 NotFoundError）
  useEffect(() => {
    if (inputId && inputs.length > 0 && !inputs.some((d) => d.id === inputId)) {
      setInputIdState('');
      writeLs(LS_INPUT, '');
    }
  }, [inputId, inputs]);
  useEffect(() => {
    if (outputId && outputs.length > 0 && !outputs.some((d) => d.id === outputId)) {
      setOutputIdState('');
      writeLs(LS_OUTPUT, '');
    }
  }, [outputId, outputs]);

  const setInputId = useCallback((id: string) => {
    setInputIdState(id);
    writeLs(LS_INPUT, id);
  }, []);
  const setOutputId = useCallback((id: string) => {
    setOutputIdState(id);
    writeLs(LS_OUTPUT, id);
  }, []);

  return {
    inputs,
    outputs,
    inputId,
    outputId,
    setInputId,
    setOutputId,
    setSinkIdSupported,
    permissionGranted,
    requestPermission,
    refresh: enumerate,
  };
}
