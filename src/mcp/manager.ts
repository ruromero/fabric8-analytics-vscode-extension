'use strict';

import * as vscode from 'vscode';
import * as path from 'path';

// Output channel interface for logging
interface OutputChannel {
  info(message: string): void;
  error(message: string): void;
  warn(message: string): void;
}

// Helper to safely call warn
function safeWarn(message: string, outputChannel: OutputChannel): void {
  outputChannel.warn(message);
}

/**
 * Manager for MCP server registration with Cursor
 * Handles the lifecycle of registering/unregistering the server as a separate process
 */
export class RhdaMcpServerManager {
  private outputChannel: OutputChannel;
  private context: vscode.ExtensionContext;
  private backendUrl: string;
  private intelServerUrl: string;
  private isRegistered: boolean = false;

  constructor(outputChannel: OutputChannel, context: vscode.ExtensionContext, backendUrl: string) {
    this.outputChannel = outputChannel;
    this.context = context;
    this.backendUrl = backendUrl;
    this.intelServerUrl = 'http://localhost:8080';
  }

  /**
   * Registers the MCP server with Cursor so it can launch it as a separate process
   */
  async register(): Promise<void> {
    if (this.isRegistered) {
      this.outputChannel.info('[MCP Server Manager] Already registered');
      return;
    }

    if (!(vscode as any).cursor?.mcp) {
      this.outputChannel.info('[MCP Server Manager] Cursor MCP API not available');
      return;
    }

    await this.doRegisterWithCursor();

    // Try to verify the server was registered by checking if there's a listServers method
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cursorApi = (vscode as any).cursor?.mcp;
      if (cursorApi?.listServers && typeof cursorApi.listServers === 'function') {
        const servers = await cursorApi.listServers();
        this.outputChannel.info(`[MCP Server Manager] Currently registered servers: ${JSON.stringify(servers)}`);
        const ourServer = Array.isArray(servers) ? servers.find((s: any) => s.name === 'rhda-mcp-server') : null;
        if (ourServer) {
          this.outputChannel.info(`[MCP Server Manager] Our server found in list: ${JSON.stringify(ourServer)}`);
        } else {
          this.outputChannel.warn(`[MCP Server Manager] Our server NOT found in the list of registered servers`);
        }
      }
    } catch (error) {
      this.outputChannel.warn(`[MCP Server Manager] Could not verify server registration: ${(error as Error).message}`);
    }

    this.isRegistered = true;
  }

  /**
   * Unregisters the MCP server from Cursor
   * This should cause Cursor to stop the separate process (via SIGTERM/SIGINT),
   * which will trigger the signal handlers in entry.ts to gracefully stop the server
   */
  async unregister(): Promise<void> {
    if (!this.isRegistered) {
      return;
    }

    if ((vscode as any).cursor?.mcp) {
      await this.doUnregisterWithCursor();
      this.outputChannel.info('[MCP Server Manager] Unregistered from Cursor. Cursor should stop the server process.');
    }
    this.isRegistered = false;
  }

  private async doRegisterWithCursor(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cursorApi = (vscode as any).cursor?.mcp;

      // Check if registerServer exists and is a function
      if (!cursorApi) {
        this.outputChannel.warn('[MCP Server] Cursor MCP API not available (cursor.mcp is undefined)');
        return;
      }

      if (!cursorApi.registerServer || typeof cursorApi.registerServer !== 'function') {
        this.outputChannel.warn('[MCP Server] Cursor registerServer API not available (registerServer is not a function)');
        this.outputChannel.info(`[MCP Server] Available cursor.mcp methods: ${Object.keys(cursorApi).join(', ')}`);
        return;
      }

      // Get the path to the external MCP server
      // The path is relative to the extension directory: ../../trustification/rhda-mcp-server
      const extensionPath = this.context.extensionPath;
      const mcpServerPath = path.resolve(extensionPath, '..', '..', 'trustification', 'rhda-mcp-server');
      const mcpServerIndexPath = path.join(mcpServerPath, 'index.ts');

      this.outputChannel.info(`[MCP Server] Registering external server with:`);
      this.outputChannel.info(`  - Extension path: ${extensionPath}`);
      this.outputChannel.info(`  - MCP server path: ${mcpServerPath}`);
      this.outputChannel.info(`  - Backend URL: ${this.backendUrl}`);
      this.outputChannel.info(`  - Intel Server URL: ${this.intelServerUrl}`);

      // Check if the MCP server directory exists
      const fs = await import('fs/promises');
      try {
        const stats = await fs.stat(mcpServerPath);
        if (!stats.isDirectory()) {
          const warnMsg = `[MCP Server] Path exists but is not a directory: ${mcpServerPath}`;
          safeWarn(warnMsg, this.outputChannel);
          return;
        }
        this.outputChannel.info(`[MCP Server] MCP server directory found and accessible`);
      } catch (error) {
        const warnMsg = `[MCP Server] MCP server directory not found at ${mcpServerPath}. Make sure the external MCP server is available.`;
        safeWarn(warnMsg, this.outputChannel);
        this.outputChannel.error(`[MCP Server] Directory access error: ${(error as Error).message}`);
        return;
      }

      // Check if index.ts exists
      try {
        await fs.access(mcpServerIndexPath);
        this.outputChannel.info(`[MCP Server] Server entry point (index.ts) found`);
      } catch (error) {
        const warnMsg = `[MCP Server] Server entry point (index.ts) not found at ${mcpServerIndexPath}`;
        safeWarn(warnMsg, this.outputChannel);
        this.outputChannel.error(`[MCP Server] File access error: ${(error as Error).message}`);
        return;
      }

      // Use the correct format according to Cursor's MCP Extension API
      // https://cursor.com/docs/context/mcp-extension-api
      // The server is started with: npx <absolute-path-to-server> --backend-url <backendUrl>
      // Use absolute path to avoid path resolution issues
      const mcpServerConfig = {
        name: 'rhda-mcp-server',
        server: {
          command: 'npx',
          args: [
            mcpServerPath,
            '--backend-url',
            this.backendUrl,
            '--intel-server-url',
            this.intelServerUrl,
          ],
          env: {
            ...process.env,
            // Set working directory to the MCP server directory
            PWD: mcpServerPath,
          },
        },
      };

      this.outputChannel.info(`[MCP Server] Attempting registration with config: ${JSON.stringify(mcpServerConfig, null, 2)}`);

      // Register the server using Cursor's official API format
      cursorApi.registerServer(mcpServerConfig);
      this.outputChannel.info(`[MCP Server] Successfully registered with Cursor using official API format`);

      // Create and show output channel for MCP server logs
      const mcpOutputChannel = vscode.window.createOutputChannel('MCP: RHDA');
      this.context.subscriptions.push(mcpOutputChannel);
      mcpOutputChannel.appendLine('[MCP Server] Server registered successfully');
      mcpOutputChannel.appendLine(`[MCP Server] Command: npx ${mcpServerPath} --backend-url ${this.backendUrl} --intel-server-url ${this.intelServerUrl}`);
      mcpOutputChannel.appendLine(`[MCP Server] Working directory: ${mcpServerPath}`);
      mcpOutputChannel.show(true);

      return;

    } catch (error) {
      const errorMessage = (error as Error).message;
      safeWarn(`[MCP Server] Failed to register with Cursor: ${errorMessage}`, this.outputChannel);
      // Log more details if available
      if (error instanceof Error && error.stack) {
        safeWarn(`[MCP Server] Stack trace: ${error.stack}`, this.outputChannel);
      }
      // Don't throw - this is optional functionality
    }
  }

  private async doUnregisterWithCursor(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cursorApi = (vscode as any).cursor?.mcp;

      // Check if unregisterServer exists and is a function
      if (cursorApi.unregisterServer && typeof cursorApi.unregisterServer === 'function') {
        await cursorApi.unregisterServer('rhda-mcp-server');
        this.outputChannel.info('[MCP Server] Successfully called unregisterServer. Cursor should stop the server process.');
      } else {
        // If unregisterServer doesn't exist, just log that we're stopping
        this.outputChannel.warn('[MCP Server] Unregister API not available. Server process may still be running.');
      }
    } catch (error) {
      const errorMessage = (error as Error).message;
      safeWarn(`[MCP Server] Failed to unregister from Cursor: ${errorMessage}`, this.outputChannel);
      // Don't throw - this is optional functionality
    }
  }
}

