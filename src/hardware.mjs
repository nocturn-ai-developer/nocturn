// Reads what the machine has and how warm it is. Every reading can be missing: virtual servers
// often hide sensors, and Windows only shares some of them without admin rights.
import { execFile } from 'node:child_process';
import { readFile, readdir, statfs } from 'node:fs/promises';
import { cpus, freemem, homedir, totalmem } from 'node:os';
import { join } from 'node:path';

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
});
const powershell = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

async function nvidia() {
  const out = await run('nvidia-smi', ['--query-gpu=name,temperature.gpu', '--format=csv,noheader,nounits']);
  return lines(out).map((line) => {
    const [name, temp] = line.split(',').map((s) => s.trim());
    return { name, temp: Number(temp) || null };
  });
}

async function gpuNames() {
  if (process.platform === 'win32') return lines(await powershell('(Get-CimInstance Win32_VideoController).Name'));
  if (process.platform === 'darwin') return lines(await run('system_profiler', ['SPDisplaysDataType'])).filter((l) => l.startsWith('Chipset Model:')).map((l) => l.slice(14).trim());
  return lines(await run('lspci', [])).filter((l) => /VGA|3D controller/.test(l)).map((l) => l.replace(/^.*?: /, ''));
}

async function physicalCores() {
  if (process.platform === 'win32') {
    const out = await powershell('(Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum');
    return Number(out.trim()) || null;
  }
  if (process.platform === 'linux') {
    const info = await readFile('/proc/cpuinfo', 'utf8').catch(() => '');
    const cores = new Set(info.split('\n\n').map((block) => `${block.match(/physical id\s*:\s*(\d+)/)?.[1]}:${block.match(/core id\s*:\s*(\d+)/)?.[1]}`));
    cores.delete('undefined:undefined');
    return cores.size || null;
  }
  return null;
}

export async function detectHardware() {
  const [gpus, cores, disk] = await Promise.all([gpuNames(), physicalCores(), statfs(homedir()).catch(() => null)]);
  const list = cpus();
  return {
    cpu: { model: list[0]?.model.replace(/\((R|TM)\)|\bCPU\b/gi, '').replace(/\s+/g, ' ').trim() ?? 'unknown', threads: list.length, cores },
    gpus,
    ramTotal: totalmem(),
    disk: disk ? { total: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize } : null,
  };
}

// The hottest CPU reading available, in °C, and where it came from.
async function cpuTemp() {
  if (process.platform === 'linux') {
    let best = null;
    for (const hw of await readdir('/sys/class/hwmon').catch(() => [])) {
      const base = join('/sys/class/hwmon', hw);
      const name = (await readFile(join(base, 'name'), 'utf8').catch(() => '')).trim();
      if (!/coretemp|k10temp|zenpower|cpu/i.test(name)) continue;
      for (const file of await readdir(base).catch(() => [])) {
        if (!/^temp\d+_input$/.test(file)) continue;
        const value = Number(await readFile(join(base, file), 'utf8').catch(() => '')) / 1000;
        if (value > 0 && value < 130 && (best === null || value > best)) best = value;
      }
    }
    return best === null ? null : { celsius: best, source: 'cpu' };
  }
  if (process.platform === 'win32') {
    // ACPI thermal zones: readable without admin, but they measure the board near the CPU.
    const out = await powershell('(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation).HighPrecisionTemperature');
    const values = lines(out).map((v) => Number(v) / 10 - 273.15).filter((v) => v > 0 && v < 130);
    return values.length ? { celsius: Math.max(...values), source: 'board' } : null;
  }
  return null;
}

export async function readSensors() {
  const [cpu, cards] = await Promise.all([cpuTemp(), nvidia()]);
  return { cpu, gpuTemp: cards.find((c) => c.temp !== null)?.temp ?? null, ramFree: freemem() };
}

// Decides how many threads should hash right now. Hot: one fewer. Cool again for a while: one more.
export function tuneThreads({ active, max, celsius, ramFreeRatio, now, lastChange }) {
  if (ramFreeRatio !== null && ramFreeRatio < 0.08 && active > 1) return { active: active - 1, reason: 'low on memory' };
  if (celsius === null) return { active, reason: null };
  if (celsius >= 85 && active > 1) return { active: active - 1, reason: `${Math.round(celsius)}°C, cooling down` };
  if (celsius <= 75 && active < max && now - lastChange >= 60000) return { active: active + 1, reason: 'cool again' };
  return { active, reason: null };
}
