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

// 文件接收状态持久化数据
interface FileTransferState {
  sessionId: string;
  filePath: string; // 原始文件路径
  localPath: string; // 本地保存路径
  originalFileName: string;
  totalChunks: number;
  receivedChunks: number[]; // 已接收的chunk索引
  senderIp: string;
  senderPort: number;
  completed: boolean; // 是否已完成
  timestamp: number;
}

export class ChatFileService {
  private readonly chunkSize: number = 1024;
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
  private readonly stateDir: string; // 状态持久化目录
  
  constructor(rootPath: string) {
    this.rootPath = rootPath;
    fs.mkdirSync(`${this.rootPath}/files`, { recursive: true });
    this.stateDir = path.join(this.rootPath, '.file_states');
    fs.mkdirSync(this.stateDir, { recursive: true });
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
          
          // 检查文件的接收状态
          const stateKey = `${ip}_${port}_${relativePath}`;
          const completed = this.isFileCompleted(stateKey);
          
          files.push({
            path: fullPath,
            name: entry.name,
            size: stats.size,
            sender: `${ip}:${port}`,
            ip,
            port,
            completed, // 标记是否已完成
          });
        }
      }
    } catch (error) {
      console.error(`扫描目录失败 ${dirPath}:`, error);
    }
  }

  /**
   * 检查文件是否接收完成
   */
  private isFileCompleted(stateKey: string): boolean {
    const state = this.loadFileState(stateKey);
    return state ? state.completed : false;
  }

  /**
   * 加载文件传输状态
   */
  private loadFileState(stateKey: string): FileTransferState | null {
    try {
      const stateFile = path.join(this.stateDir, `${stateKey.replace(/[/\\:]/g, '_')}.json`);
      if (fs.existsSync(stateFile)) {
        return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      }
    } catch (error) {
      console.error('加载文件状态失败:', error);
    }
    return null;
  }

  /**
   * 保存文件传输状态
   */
  private saveFileState(stateKey: string, state: FileTransferState): void {
    try {
      const stateFile = path.join(this.stateDir, `${stateKey.replace(/[/\\:]/g, '_')}.json`);
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error('保存文件状态失败:', error);
    }
  }

  /**
   * 删除文件
   */
  public async deleteFile(filePath: string): Promise<boolean> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        
        // 删除对应的状态文件
        // TODO: 根据 filePath 找到对应的 stateKey 并删除状态文件
        
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
    const safePath = this.getSafeRelativePath(file.path);
    const targetPath = path.join(
      this.rootPath,
      `${file.ip}_${file.port}`,
      safePath,
    );
    const filename = path.basename(file.path);
    const stateKey = `${file.ip}_${file.port}_${safePath}`;

    // 检查是否有未完成的传输
    const existingState = this.loadFileState(stateKey);
    
    if (existingState && !existingState.completed) {
      // 有未完成的传输，询问用户是继续还是重新开始
      const answer = await vscode.window.showInformationMessage(
        `文件 ${filename} 有未完成的传输（已接收 ${existingState.receivedChunks.length}/${existingState.totalChunks} 块），要继续吗？`,
        "继续",
        "重新开始",
        "取消"
      );
      
      if (answer === "继续") {
        // 请求缺失的 chunk
        const missingChunks: number[] = [];
        const receivedSet = new Set(existingState.receivedChunks);
        for (let i = 0; i < existingState.totalChunks; i++) {
          if (!receivedSet.has(i)) {
            missingChunks.push(i);
          }
        }
        
        if (missingChunks.length > 0) {
          messageService.sendFileRequest(file, missingChunks);
        }
        return;
      } else if (answer === "重新开始") {
        // 删除旧文件和状态
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
        }
        // 状态会在开始新传输时被覆盖
      } else {
        return; // 取消
      }
    }

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
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "");
    this.fds.set(targetPath, fs.openSync(targetPath, "r+"));
    
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
      return;
    }
    
    const safePath = this.getSafeRelativePath(value);
    const filePath = path.join(this.rootPath, `${ip}_${port}`, safePath);
    const stateKey = `${ip}_${port}_${safePath}`;
    
    // 初始化进度条和会话
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
      
      // 确保文件已打开
      if (!this.fds.has(filePath)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "");
        this.fds.set(filePath, fs.openSync(filePath, "r+"));
      }
    }
    
    const session = this.activeDownloads.get(progressKey);
    if (!session) {
      return;
    }

    const fd = this.fds.get(filePath);
    if (!fd) {
      return;
    }

    // 保存chunk数据
    const buffer = Buffer.isBuffer(chunk.data)
      ? chunk.data
      : Buffer.from((chunk.data as any).data);

    fs.writeSync(fd, buffer, 0, chunk.size, chunk.index * this.chunkSize);
    
    // 记录已接收的chunk
    session.receivedChunks.add(chunk.index);
    
    // 更新进度
    if (chunk.total && chunk.total > 0) {
      const percentage = Math.floor((session.receivedChunks.size / chunk.total) * 100);
      const increment = percentage - session.lastPercentage;
      if (increment > 0) {
        session.report({ increment, message: `${percentage}% (${session.receivedChunks.size}/${chunk.total})` });
        session.lastPercentage = percentage;
      }
    }
    
    // 每10个chunk保存一次状态
    if (session.receivedChunks.size % 10 === 0) {
      this.saveFileState(stateKey, {
        sessionId: session.sessionId,
        filePath: session.originalFilePath,
        localPath: filePath,
        originalFileName: session.originalFileName,
        totalChunks: session.totalChunks,
        receivedChunks: Array.from(session.receivedChunks),
        senderIp: session.senderIp,
        senderPort: session.senderPort,
        completed: false,
        timestamp: Date.now()
      });
    }

    // 检查是否接收完成（收到了最后一个chunk）
    if (chunk.finish && session.receivedChunks.size === chunk.total) {
      console.log(`文件传输完成：${path.basename(value)}，共 ${chunk.total} 个块`);
      
      // 保存完成状态
      this.saveFileState(stateKey, {
        sessionId: session.sessionId,
        filePath: session.originalFilePath,
        localPath: filePath,
        originalFileName: session.originalFileName,
        totalChunks: session.totalChunks,
        receivedChunks: Array.from(session.receivedChunks),
        senderIp: session.senderIp,
        senderPort: session.senderPort,
        completed: true,
        timestamp: Date.now()
      });
      
      // 发送接收完成确认
      if (this.messageServiceRef) {
        this.messageServiceRef.sendFileReceivedConfirm(
          value,
          session.sessionId,
          session.senderIp,
          session.senderPort
        );
      }
      
      // 关闭文件
      fs.closeSync(fd);
      this.fds.delete(filePath);
      
      // 结束进度条
      session.resolve();
      this.activeDownloads.delete(progressKey);

      // 打开文件
      this.openFileInEditor(filePath);
    }
  }
}
