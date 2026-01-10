import si from "systeminformation";
import { logger } from "../utils/logger.js";

export interface SystemStatus {
  cpu: number;
  memory: {
    used: number;
    total: number;
    percent: number;
  };
  disk: {
    used: number;
    total: number;
    percent: number;
  };
  uptime: string;
}

export interface ProcessInfo {
  name: string;
  cpu: number;
  memory: number;
}

export interface BatteryInfo {
  percent: number;
  isCharging: boolean;
  timeRemaining: number | null;
}

export class SystemService {
  async getStatus(): Promise<SystemStatus> {
    try {
      const [cpu, mem, disk, time] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.time(),
      ]);

      const primaryDisk = disk[0] || { used: 0, size: 0 };

      const uptimeSeconds = time.uptime || 0;
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const uptime = `${hours}h ${minutes}m`;

      return {
        cpu: Math.round(cpu.currentLoad * 10) / 10,
        memory: {
          used: Math.round(mem.used / (1024 * 1024 * 1024)),
          total: Math.round(mem.total / (1024 * 1024 * 1024)),
          percent: Math.round((mem.used / mem.total) * 100),
        },
        disk: {
          used: Math.round(primaryDisk.used / (1024 * 1024 * 1024)),
          total: Math.round(primaryDisk.size / (1024 * 1024 * 1024)),
          percent: Math.round((primaryDisk.used / primaryDisk.size) * 100),
        },
        uptime,
      };
    } catch (error) {
      logger.error("System", "System status error", error);
      throw error;
    }
  }

  async getTopProcesses(limit = 5): Promise<ProcessInfo[]> {
    try {
      const processes = await si.processes();

      return processes.list
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, limit)
        .map((p) => ({
          name: p.name.slice(0, 25),
          cpu: Math.round(p.cpu * 10) / 10,
          memory: Math.round(p.mem * 10) / 10,
        }));
    } catch (error) {
      logger.error("System", "Process list error", error);
      return [];
    }
  }

  async getBatteryInfo(): Promise<BatteryInfo | null> {
    try {
      const battery = await si.battery();
      if (!battery || battery.hasBattery === false) {
        return null; // Desktop system without battery
      }
      return {
        percent: battery.percent || 100,
        isCharging: battery.isCharging || false,
        timeRemaining: battery.timeRemaining || null,
      };
    } catch (error) {
      logger.error("System", "Battery info error", error);
      return null;
    }
  }

  formatStatus(status: SystemStatus): string {
    return `System Performance:
🖥️ CPU Usage: ${status.cpu}%
🧠 Memory: ${status.memory.percent}% used (${status.memory.used}GB / ${status.memory.total}GB)
💽 Disk: ${status.disk.percent}% used
⏰ Uptime: ${status.uptime}`;
  }
}
