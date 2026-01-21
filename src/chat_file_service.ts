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
  completed: boolean; // 新增：标记文件是否接收完成
}

export class ChatFileService {
  // 优化chunk大小以适应MTU限制，避免IP分片
  // 与ChatMessageService保持一致
  private readonly chunkSize: number = 256;
  private fds: Map<string, number> = new Map();
  // 存储文件下载进度
  private activeDownloads = new Map<string, {
    resolve: () => void;
    report: (value: { message?: string; increment?: number }) => void;
    lastPercentage: number;
    receivedChunks: Set<number>;
    totalChunks: number;
    sessionId: string;
    senderIp: string;
    senderPort: number;
    filePath: string;
    originalFilePath: string;
    originalFileName: string;
  }>();
  
  rootPath: string;
  private messageServiceRef?: ChatMessageService;
  
  constructor(rootPath: string) {
    this.rootPath = rootPath;
    fs.mkdirSync(`${this.rootPath}/files`, { recursive: true });
  }
  
  public setMessageService(messageService: ChatMessageService): void {
    this.messageServiceRef = messageService;
  }
  
  public dispose(): void {
    // 关闭所有文件句柄
    for (const [filePath, fd] of this.fds.entries()) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        console.error(`关闭文件句柄失败 ${filePath}:`, error);
      }
    }
    this.fds.clear();
  }

  /**
   * 获取安全的相对路径，支持跨平台路径处理
   */
  private getSafeRelativePath(filePath: string): string {
    const winDriveMatch = filePath.match(/^[a-zA-Z]:\\/);
    if (winDriveMatch) {
      const withoutDrive = filePath.substring(3);
      return withoutDrive.replace(/\\/g, '/');
    }
    
    if (filePath.startsWith('/')) {
      return filePath.substring(1);
    }
    
    return filePath.replace(/\\/g, '/');
  }

  /**
   * 在编辑器中打开文件
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
   * 获取所有接收的文件列表（包括完成状态）
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
          this.scanDirectoryForFiles(fullPath, ip, port, files);
        } else if (entry.isFile()) {
          const stats = fs.statSync(fullPath);
          const relativePath = path.relative(
            path.join(this.rootPath, `${ip}_${port}`),
            fullPath
          );
          
          files.push({
            path: fullPath,
            name: entry.name,
            size: stats.size,
            sender: `${ip}:${port}`,
            ip,
            port,
            completed: true, // 简化：假设已下载的文件都是完整的
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
   * 打开文件
   */
  public async openFile(filePath: string): Promise<void> {
    await this.openFileInEditor(filePath);
  }

  /**
   * 下载文件
   */
  public async download(
    file: ChatFileMetadata,
    messageService: ChatMessageService,
  ): Promise<void> {
    console.log(`[download] 开始下载文件 - path: ${file.path}, ip: ${file.ip}, port: ${file.port}`);
    
    const safePath = this.getSafeRelativePath(file.path);
    const targetPath = path.join(
      this.rootPath,
      `${file.ip}_${file.port}`,
      safePath,
    );
    const filename = path.basename(file.path);

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
      // 文件已存在且完整
      const answer = await vscode.window.showWarningMessage(
        `文件 ${filename} 已存在，是否覆盖？`,
        { modal: true },
        "覆盖",
        "取消",
      );

      if (answer === "覆盖") {
        fs.unlinkSync(targetPath);
      } else {
        await this.openFileInEditor(targetPath);
        return;
      }
    }

    // 创建文件并开始下载
    console.log(`[download] 创建文件并准备下载`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "");
    this.fds.set(targetPath, fs.openSync(targetPath, "r+"));
    
    console.log(`[download] 发送文件请求`);
    // 发送chunk请求（不指定requestChunks，表示请求所有chunk）
    messageService.sendFileRequest(file);
  }

  /**
   * 保存接收到的chunk
   */
  public saveChunk(
    value: string | undefined,
    chunk: ChatFileChunk | undefined,
    ip: string,
    port: number,
    sessionId?: string,
  ) {
    if (!value || !chunk) {
      console.error(`[saveChunk] value或chunk为空`);
      return;
    }
    
    console.log(`[saveChunk] 收到chunk - index: ${chunk.index}, size: ${chunk.size}, total: ${chunk.total}, sessionId: ${sessionId}`);
    
    const safePath = this.getSafeRelativePath(value);
    const filePath = path.join(this.rootPath, `${ip}_${port}`, safePath);
    const stateKey = `${ip}_${port}_${safePath}`;
    
    // 初始化进度条和会话
    const progressKey = `${ip}_${port}_${value}`;
    if (!this.activeDownloads.has(progressKey) && chunk.total && chunk.total > 0) {
      console.log(`[saveChunk] 创建新的接收会话 - progressKey: ${progressKey}, totalChunks: ${chunk.total}`);
      
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
        report: () => {},
        lastPercentage: 0,
        receivedChunks: new Set<number>(),
        totalChunks: chunk.total,
        sessionId: sessionId || `${ip}_${port}_${value}_${Date.now()}`,
        senderIp: ip,
        senderPort: port,
        filePath: filePath,
        originalFilePath: value,
        originalFileName: path.basename(value),
      });
      
      console.log(`[saveChunk] 接收会话已创建`);
      
      // 确保文件已打开
      if (!this.fds.has(filePath)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "");
        this.fds.set(filePath, fs.openSync(filePath, "r+"));
        console.log(`[saveChunk] 文件已创建并打开: ${filePath}`);
      }
    }
    
    const session = this.activeDownloads.get(progressKey);
    if (!session) {
      console.error(`[saveChunk] 未找到接收会话: ${progressKey}`);
      return;
    }

    const fd = this.fds.get(filePath);
    if (!fd) {
      console.error(`[saveChunk] 未找到文件描述符: ${filePath}`);
      return;
    }

    // 保存chunk数据
    const buffer = Buffer.isBuffer(chunk.data)
      ? chunk.data
      : Buffer.from((chunk.data as any).data);

    fs.writeSync(fd, buffer, 0, chunk.size, chunk.index * this.chunkSize);
    
    // 记录已接收的chunk
    session.receivedChunks.add(chunk.index);
    
    console.log(`[saveChunk] chunk已写入 - index: ${chunk.index}, 已接收: ${session.receivedChunks.size}/${session.totalChunks}`);
    
    // 更新进度
    if (chunk.total && chunk.total > 0) {
      const percentage = Math.floor((session.receivedChunks.size / chunk.total) * 100);
      const increment = percentage - session.lastPercentage;
      if (increment > 0) {
        session.report({ increment, message: `${percentage}% (${session.receivedChunks.size}/${chunk.total})` });
        session.lastPercentage = percentage;
        console.log(`[saveChunk] 进度更新: ${percentage}%`);
      }
    }

    // 检查是否接收完成（已收到所有chunk）
    if (chunk.total && session.receivedChunks.size === chunk.total) {
      console.log(`[saveChunk] 🎉 文件传输完成！${path.basename(value)}，共 ${chunk.total} 个块`);
      
      // 发送接收完成确认
      if (this.messageServiceRef) {
        console.log(`[saveChunk] 发送接收完成确认 - sessionId: ${session.sessionId}`);
        this.messageServiceRef.sendFileReceivedConfirm(
          value,
          session.sessionId,
          session.senderIp,
          session.senderPort
        );
      } else {
        console.error(`[saveChunk] messageServiceRef为空，无法发送确认`);
      }
      
      // 关闭文件
      try {
        fs.closeSync(fd);
        this.fds.delete(filePath);
        console.log(`[saveChunk] 文件句柄已关闭`);
      } catch (error) {
        console.error(`[saveChunk] 关闭文件句柄失败:`, error);
      }
      
      // 结束进度条
      session.resolve();
      this.activeDownloads.delete(progressKey);
      console.log(`[saveChunk] 接收会话已清理，剩余会话数: ${this.activeDownloads.size}`);

      // 打开文件
      this.openFileInEditor(filePath);
    }
  }
}
