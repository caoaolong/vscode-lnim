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

export class ChatFileService {
  private readonly chunkSize: number = 1024;
  private fds: Map<string, number> = new Map();
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
      if (chunk.finish) {
        fs.closeSync(fd);
        this.fds.delete(filePath);
        // 文件接收完成，在编辑器中打开文件
        this.openFileInEditor(filePath);
      }
    }
  }
}
