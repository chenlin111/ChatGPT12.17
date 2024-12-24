// client/platforms/google.ts
import { ApiPath, Google, REQUEST_TIMEOUT_MS } from "@/app/constant";
import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  SpeechOptions,
} from "../api";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
  ChatMessageTool,
} from "@/app/store";
import { getClientConfig } from "@/app/config/client";
import { GEMINI_BASE_URL } from "@/app/constant";

import {
  getMessageTextContent,
  getMessageImages,
  isVisionModel,
} from "@/app/utils";
import { preProcessImageContent } from "@/app/utils/chat";
import { nanoid } from "nanoid";
import { RequestPayload } from "./openai";

export class GeminiProApi implements LLMApi {
  path(path: string, shouldStream = false): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";
    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.googleUrl;
    }

    const isApp = !!getClientConfig()?.isApp;
    if (baseUrl.length === 0) {
      baseUrl = isApp ? GEMINI_BASE_URL : ApiPath.Google;
    }
    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Google)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    let chatPath = [baseUrl, path].join("/");
    if (shouldStream) {
      chatPath += chatPath.includes("?") ? "&alt=sse" : "?alt=sse";
    }

    return chatPath;
  }
  extractMessage(res: any) {
    console.log("[Response] gemini-pro response: ", res);

    return (
      res?.candidates?.at(0)?.content?.parts.at(0)?.text ||
      res?.at(0)?.candidates?.at(0)?.content?.parts.at(0)?.text ||
      res?.error?.message ||
      ""
    );
  }
  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }
  async chat(options: ChatOptions): Promise<void> {
    const controller = new AbortController();
    options.onController?.(controller);
    try {
      const modelConfig = {
        ...useAppConfig.getState().modelConfig,
        ...useChatStore.getState().currentSession().mask.modelConfig,
        ...{
          model: options.config.model,
        },
      };
      const chatPath = this.path(
        Google.ChatPath(modelConfig.model),
        !!options.config.stream,
      );
      const messages = await this.prepareMessages(
        options.messages,
        options.config.model,
      );

      const requestPayload = {
        contents: messages,
        generationConfig: {
          temperature: modelConfig.temperature,
          maxOutputTokens: modelConfig.max_tokens,
          topP: modelConfig.top_p,
        },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: useAccessStore.getState().googleSafetySettings,
          },
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: useAccessStore.getState().googleSafetySettings,
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: useAccessStore.getState().googleSafetySettings,
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: useAccessStore.getState().googleSafetySettings,
          },
        ],
      };

      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      if (options.config.stream) {
        await this.handleStreamResponse(
          chatPath,
          chatPayload,
          options,
          controller,
        );
      } else {
        await this.handleNonStreamResponse(
          chatPath,
          chatPayload,
          options,
          controller,
          requestTimeoutId,
        );
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }
  async prepareMessages(messages: ChatOptions["messages"], model: string) {
    let multimodal = false;
    const _messages: ChatOptions["messages"] = [];
    for (const v of messages) {
      const content = await preProcessImageContent(v.content);
      _messages.push({ role: v.role, content });
    }
    const processedMessages = _messages.map((v) => {
      let parts: any[] = [{ text: getMessageTextContent(v) }];
      if (isVisionModel(model)) {
        const images = getMessageImages(v);
        if (images.length > 0) {
          multimodal = true;
          parts = parts.concat(
            images.map((image) => {
              const imageType = image.split(";")[0].split(":")[1];
              const imageData = image.split(",")[1];
              return {
                inline_data: {
                  mime_type: imageType,
                  data: imageData,
                },
              };
            }),
          );
        }
      }
      return {
        role: v.role.replace("assistant", "model").replace("system", "user"),
        parts: parts,
      };
    });

    for (let i = 0; i < processedMessages.length - 1; ) {
      if (processedMessages[i].role === processedMessages[i + 1].role) {
        processedMessages[i].parts = processedMessages[i].parts.concat(
          processedMessages[i + 1].parts,
        );
        processedMessages.splice(i + 1, 1);
      } else {
        i++;
      }
    }
    return processedMessages;
  }
  async handleStreamResponse(
    chatPath: string,
    chatPayload: any,
    options: ChatOptions,
    controller: AbortController,
  ) {
    const response = await fetch(chatPath, chatPayload);
    if (!response.ok) {
      const errorData = await response.json();
      options.onError?.(new Error(`API Error: ${errorData.error}`));
      return;
    }
    const reader = response?.body?.getReader();
    const decoder = new TextDecoder();
    let partialResponse = "";
    try {
      while (true) {
        const { done, value } = await reader!.read();
        if (done) {
          if (partialResponse) {
            options.onFinish(partialResponse, {});
          }
          break;
        }
        partialResponse += decoder.decode(value);
        options.onUpdate?.(decoder.decode(value));
      }
    } catch (e) {
      console.log("[Request] failed to make a stream chat request", e);
      options.onError?.(e as Error);
    }
  }
  async handleNonStreamResponse(
    chatPath: string,
    chatPayload: any,
    options: ChatOptions,
    controller: AbortController,
    requestTimeoutId: any,
  ) {
    const res = await fetch(chatPath, chatPayload);
    clearTimeout(requestTimeoutId);
    const resJson = await res.json();
    if (resJson?.promptFeedback?.blockReason) {
      options.onError?.(
        new Error(
          "Message is being blocked for reason: " +
            resJson.promptFeedback.blockReason,
        ),
      );
    }
    const message = this.extractMessage(resJson);
    options.onFinish(message, res);
  }
  async *generateGeminiStream(message: string): AsyncGenerator<string> {
    const chatStore = useChatStore.getState();
    const currentSession = chatStore.currentSession();
    const chatOptions: ChatOptions = {
      messages: [
        {
          role: "user",
          content: message,
        },
      ],
      config: {
        model: currentSession.mask.modelConfig.model,
        stream: true,
        temperature: currentSession.mask.modelConfig.temperature,
        top_p: currentSession.mask.modelConfig.top_p,
        max_tokens: currentSession.mask.modelConfig.max_tokens,
      },
      onUpdate(message: string) {
        console.log("onUpdate", message);
      },
      onFinish(message: string, responseRes: Response) {
        console.log("onFinish", message, responseRes);
      },
      onError(err: Error) {
        console.log("onError", err);
      },
    };
    const controller = new AbortController();
    chatOptions.onController = (controller) => controller;
    try {
      const modelConfig = {
        ...useAppConfig.getState().modelConfig,
        ...useChatStore.getState().currentSession().mask.modelConfig,
        ...{
          model: chatOptions.config.model,
        },
      };
      const chatPath = this.path(
        Google.ChatPath(modelConfig.model),
        !!chatOptions.config.stream,
      );
      const messages = await this.prepareMessages(
        chatOptions.messages,
        chatOptions.config.model,
      );

      const requestPayload = {
        contents: messages,
        generationConfig: {
          temperature: modelConfig.temperature,
          maxOutputTokens: modelConfig.max_tokens,
          topP: modelConfig.top_p,
        },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: useAccessStore.getState().googleSafetySettings,
          },
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: useAccessStore.getState().googleSafetySettings,
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: useAccessStore.getState().googleSafetySettings,
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: useAccessStore.getState().googleSafetySettings,
          },
        ],
      };

      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };
      const response = await fetch(chatPath, chatPayload);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`API Error: ${errorData.error}`);
      }
      const reader = response?.body?.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader!.read();
        if (done) {
          break;
        }
        yield decoder.decode(value);
      }
    } catch (e) {
      console.log("[Request] failed to make a stream chat request", e);
      throw e;
    }
  }
  usage(): Promise<LLMUsage> {
    throw new Error("Method not implemented.");
  }
  async models(): Promise<LLMModel[]> {
    return [];
  }
}
