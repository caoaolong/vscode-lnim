import * as fs from "fs";
import { ChatFileChunk, ChatMessageService } from "./chat_message_service";
import * as path from "path";
import * as vscode from "vscode";

export interface ChatFileMetadata {
  ip: string;
  port: number;
  username: string;
  path: string;
}

export interface ReceivedFile {
  path: string;
  name: string;
  size: number;
  sender: string;
  ip: string;
  port: number;
}

export class ChatFileService {
  private readonly chunkSize: number = 1024;
  private fds: Map<string, number> = new Map();
  // 存储文件下载进度的会话信息
  private activeDownloads = new Map<string, {
    resolve: () => void;
    report: (value: { message?: string; increment?: number }) => void;
    lastPercentage: number;
  }>();
  rootPath: string;
  constructor(rootPath: string) {
    this.rootPath = rootPath;
    fs.mkdirSync(`${this.rootPath}/files`, { recursive: true });
  }

  /**
   * 获取安全的相对路径，防止绝对路径导致的错误
   */
  private getSafeRelativePath(filePath: string): string {
    const parsed = path.parse(filePath);
    let relativePath = filePath;
    if (parsed.root) {
      relativePath = path.relative(parsed.root, filePath);
    }
    return relativePath;
  }

  /**
   * 在编辑器中打开文件
   * 使用 VS Code 的默认方式打开文件（会根据文件类型自动选择合适的编辑器）
   */
  private async openFileInEditor(filePath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      await vscode.commands.executeCommand("vscode.open", uri);
    } catch (error) {
      vscode.window.showErrorMessage(
        `无法打开文件: ${path.basename(filePath)}`,
      );
      console.error("打开文件失败:", error);
    }
  }

  /**
   * 获取所有接收的文件列表
   */
  public getFiles(): ReceivedFile[] {
    const files: ReceivedFile[] = [];
    
    if (!fs.existsSync(this.rootPath)) {
      return files;
    }

    try {
      // 扫描根目录下的所有目录（格式为 ${ip}_${port}）
      const entries = fs.readdirSync(this.rootPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        // 解析目录名，提取 IP 和端口
        const dirMatch = entry.name.match(/^(.+)_(\d+)$/);
        if (!dirMatch) {
          continue;
        }

        const [, ip, portStr] = dirMatch;
        const port = parseInt(portStr, 10);
        const dirPath = path.join(this.rootPath, entry.name);

        // 递归扫描目录下的所有文件
        this.scanDirectoryForFiles(dirPath, ip, port, files);
      }
    } catch (error) {
      console.error("获取文件列表失败:", error);
    }

    return files;
  }

  /**
   * 递归扫描目录中的文件
   */
  private scanDirectoryForFiles(
    dirPath: string,
    ip: string,
    port: number,
    files: ReceivedFile[]
  ): void {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          // 递归扫描子目录
          this.scanDirectoryForFiles(fullPath, ip, port, files);
        } else if (entry.isFile()) {
          // 获取文件信息
          const stats = fs.statSync(fullPath);
          const relativePath = path.relative(
            path.join(this.rootPath, `${ip}_${port}`),
            fullPath
          );
          
          files.push({
            path: fullPath,
            name: entry.name,
            size: stats.size,
            sender: `${ip}:${port}`, // 默认显示 IP:Port，后续可以从联系人中获取用户名
            ip,
            port,
          });
        }
      }
    } catch (error) {
      console.error(`扫描目录失败 ${dirPath}:`, error);
    }
  }

  /**
   * 删除文件
   */
  public async deleteFile(filePath: string): Promise<boolean> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        
        // 如果文件所在目录为空，尝试删除目录
        const dirPath = path.dirname(filePath);
        try {
          const dirEntries = fs.readdirSync(dirPath);
          if (dirEntries.length === 0) {
            fs.rmdirSync(dirPath);
          }
        } catch {
          // 忽略删除目录的错误
        }
        
        return true;
      }
      return false;
    } catch (error) {
      console.error("删除文件失败:", error);
      return false;
    }
  }

  /**
   * 打开文件（公开方法）
   */
  public async openFile(filePath: string): Promise<void> {
    await this.openFileInEditor(filePath);
  }

  public async download(
    file: ChatFileMetadata,
    messageService: ChatMessageService,
  ): Promise<void> {
    const safePath = this.getSafeRelativePath(file.path);
    const targetPath = path.join(
      this.rootPath,
      `${file.ip}_${file.port}`,
      safePath,
    );
    const filename = path.basename(file.path);

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
      // 文件已存在，询问用户是否要覆盖
      const answer = await vscode.window.showWarningMessage(
        `文件 ${filename} 已存在，是否覆盖？`,
        { modal: true },
        "覆盖",
        "取消",
      );

      if (answer === "覆盖") {
        // 用户选择覆盖，删除旧文件并重新创建
        fs.unlinkSync(targetPath);
        fs.writeFileSync(targetPath, "");
        this.fds.set(targetPath, fs.openSync(targetPath, "r+"));
        messageService.sendFileMessage(file);
        return;
      } else if (answer === "取消") {
        // 用户取消覆盖，在编辑器中打开已存在的文件
        await this.openFileInEditor(targetPath);
        return;
      }
    }

    // 文件不存在，直接创建
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "");
    this.fds.set(targetPath, fs.openSync(targetPath, "r+"));
    messageService.sendFileMessage(file);
  }

  public saveChunk(
    value: string | undefined,
    chunk: ChatFileChunk | undefined,
    ip: string,
    port: number,
  ) {
    // 保存文件
    if (!value || !chunk) {
      return;
    }
    const safePath = this.getSafeRelativePath(value);
    const filePath = path.join(this.rootPath, `${ip}_${port}`, safePath);
    
    // 初始化或获取进度条会话
    const progressKey = `${ip}_${port}_${value}`;
    if (!this.activeDownloads.has(progressKey) && chunk.total && chunk.total > 0) {
      let resolveFunc: () => void;
      const p = new Promise<void>((resolve) => {
        resolveFunc = resolve;
      });

      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `正在接收文件: ${path.basename(value)}`,
        cancellable: false
      }, (progress) => {
        const s = this.activeDownloads.get(progressKey);
        if (s) {
          s.report = progress.report;
        }
        return p;
      });

      this.activeDownloads.set(progressKey, {
        resolve: resolveFunc!,
        report: () => {}, // 占位符，等待 callback 替换
        lastPercentage: 0
      });
    }

    if (this.fds.has(filePath)) {
      const fd = this.fds.get(filePath);
      if (!fd) {
        return;
      }

      // 将 chunk.data 转换为 Buffer（因为 JSON.parse 后 Buffer 会变成普通对象）
      const buffer = Buffer.isBuffer(chunk.data)
        ? chunk.data
        : Buffer.from((chunk.data as any).data);

      fs.writeSync(fd, buffer, 0, chunk.size, chunk.index * this.chunkSize);
      
      // 更新进度
      const session = this.activeDownloads.get(progressKey);
      if (session && chunk.total && chunk.total > 0) {
        const percentage = Math.floor(((chunk.index + 1) / chunk.total) * 100);
        const increment = percentage - session.lastPercentage;
        if (increment > 0) {
          // 如果 report 还没被替换（callback还没跑），这里调用可能会丢一次更新
          // 但对于进度条来说问题不大，下次更新会补上
          session.report({ increment, message: `${percentage}%` });
          session.lastPercentage = percentage;
        }
      }

      if (chunk.finish) {
        fs.closeSync(fd);
        this.fds.delete(filePath);
        
        // 结束进度条
        if (session) {
          session.resolve();
          this.activeDownloads.delete(progressKey);
        }

        // 文件接收完成，在编辑器中打开文件
        this.openFileInEditor(filePath);
      }
    }
  }
}
