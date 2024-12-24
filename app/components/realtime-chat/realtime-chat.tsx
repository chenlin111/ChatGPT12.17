import React, { useState, useRef, useEffect } from "react";
import VoiceIcon from "@/app/icons/voice.svg";
import VoiceOffIcon from "@/app/icons/voice-off.svg";
import PowerIcon from "@/app/icons/power.svg";
import styles from "./realtime-chat.module.scss";
import clsx from "clsx";
import { useChatStore, createMessage, useAppConfig } from "@/app/store";
import { IconButton } from "@/app/components/button";
import {
  Modality,
  RTClient,
  RTInputAudioItem,
  RTResponse,
  TurnDetection,
} from "rt-client";
import { AudioHandler } from "@/app/lib/audio";
import { uploadImage } from "@/app/utils/chat";
import { VoicePrint } from "@/app/components/voice-print";
import { ChatMessage } from "@/types"; // 引入 ChatMessage 类型
import { Loading } from "@/app/components/loading"; // 引入加载组件

interface RealtimeChatProps {
  onClose?: () => void;
  onStartVoice?: () => void;
  onPausedVoice?: () => void;
}

export function RealtimeChat({
  onClose,
  onStartVoice,
  onPausedVoice,
}: RealtimeChatProps) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const config = useAppConfig();
  const [status, setStatus] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [modality, setModality] = useState("audio");
  const [useVAD, setUseVAD] = useState(true);
  const [frequencies, setFrequencies] = useState<Uint8Array | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]); // 增加消息列表状态

  const clientRef = useRef<RTClient | null>(null);
  const audioHandlerRef = useRef<AudioHandler | null>(null);
  const initRef = useRef(false);

  const temperature = config.realtimeConfig.temperature;
  const apiKey = config.realtimeConfig.apiKey;
  const model = config.realtimeConfig.model;
  const azure = config.realtimeConfig.provider === "Azure";
  const azureEndpoint = config.realtimeConfig.azure.endpoint;
  const azureDeployment = config.realtimeConfig.azure.deployment;
  const voice = config.realtimeConfig.voice;

  // 连接和断开连接函数
  const handleConnect = async () => {
    if (isConnecting) return;
    if (!isConnected) {
      try {
        setIsConnecting(true);
        setStatus("Connecting...");
        clientRef.current = azure
          ? new RTClient(
              new URL(azureEndpoint),
              { key: apiKey },
              { deployment: azureDeployment },
            )
          : new RTClient({ key: apiKey }, { model });
        const modalities: Modality[] =
          modality === "audio" ? ["text", "audio"] : ["text"];
        const turnDetection: TurnDetection = useVAD
          ? { type: "server_vad" }
          : null;
        await clientRef.current.configure({
          instructions: "",
          voice,
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: turnDetection,
          tools: [],
          temperature,
          modalities,
        });
        startResponseListener();
        setIsConnected(true);
        setStatus("");
      } catch (error: any) {
        console.error("Connection failed:", error);
        setStatus(`Connection failed: ${error.message}`);
      } finally {
        setIsConnecting(false);
      }
    } else {
      await disconnect();
    }
  };

  const disconnect = async () => {
    if (clientRef.current) {
      try {
        setStatus("Disconnecting...");
        await clientRef.current.close();
        clientRef.current = null;
        setIsConnected(false);
        setStatus("");
      } catch (error: any) {
        console.error("Disconnect failed:", error);
        setStatus(`Disconnect failed: ${error.message}`);
      }
    }
  };

  // 响应监听器
  const startResponseListener = async () => {
    if (!clientRef.current) return;

    try {
      for await (const serverEvent of clientRef.current.events()) {
        if (serverEvent.type === "response") {
          await handleResponse(serverEvent);
        } else if (serverEvent.type === "input_audio") {
          await handleInputAudio(serverEvent);
        }
      }
    } catch (error: any) {
      if (clientRef.current) {
        console.error("Response iteration error:", error);
        setStatus(`Response iteration error: ${error.message}`);
      }
    }
  };

  // 处理响应
  const handleResponse = async (response: RTResponse) => {
    for await (const item of response) {
      if (item.type === "message" && item.role === "assistant") {
        const botMessage = createMessage({
          role: item.role,
          content: "",
        });
        // add bot message first
        chatStore.updateTargetSession(session, (session) => {
          session.messages = session.messages.concat([botMessage]);
        });
        let hasAudio = false;
        let messageContent = ""; // 用于存储完整消息内容
        for await (const content of item) {
          if (content.type === "text") {
            for await (const text of content.textChunks()) {
              messageContent += text; // 累加文本
              botMessage.content = messageContent; // 更新消息内容
            }
          } else if (content.type === "audio") {
            const textTask = async () => {
              for await (const text of content.transcriptChunks()) {
                messageContent += text;
                botMessage.content = messageContent;
              }
            };
            const audioTask = async () => {
              audioHandlerRef.current?.startStreamingPlayback();
              for await (const audio of content.audioChunks()) {
                hasAudio = true;
                audioHandlerRef.current?.playChunk(audio);
              }
            };
            await Promise.all([textTask(), audioTask()]);
          }
          // update message.content
          chatStore.updateTargetSession(session, (session) => {
            session.messages = session.messages.concat();
          });
        }
        if (hasAudio) {
          // upload audio get audio_url
          const blob = audioHandlerRef.current?.savePlayFile();
          uploadImage(blob!).then((audio_url) => {
            botMessage.audio_url = audio_url;
            // update text and audio_url
            chatStore.updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          });
        }
        setMessages((prev) => [...prev, botMessage]);
      }
    }
  };

  // 处理输入音频
  const handleInputAudio = async (item: RTInputAudioItem) => {
    await item.waitForCompletion();
    if (item.transcription) {
      const userMessage = createMessage({
        role: "user",
        content: item.transcription,
      });
      chatStore.updateTargetSession(session, (session) => {
        session.messages = session.messages.concat([userMessage]);
      });
      // save input audio_url, and update session
      const { audioStartMillis, audioEndMillis } = item;
      // upload audio get audio_url
      const blob = audioHandlerRef.current?.saveRecordFile(
        audioStartMillis,
        audioEndMillis,
      );
      uploadImage(blob!).then((audio_url) => {
        userMessage.audio_url = audio_url;
        chatStore.updateTargetSession(session, (session) => {
          session.messages = session.messages.concat();
        });
      });
      setMessages((prev) => [...prev, userMessage]); // 添加用户消息到消息列表
    }
    // stop streaming play after get input audio.
    audioHandlerRef.current?.stopStreamingPlayback();
  };

  // 控制录音
  const toggleRecording = async () => {
    if (!isRecording && clientRef.current) {
      try {
        setStatus("Starting recording...");
        if (!audioHandlerRef.current) {
          audioHandlerRef.current = new AudioHandler();
          await audioHandlerRef.current.initialize();
        }
        await audioHandlerRef.current.startRecording(async (chunk) => {
          await clientRef.current?.sendAudio(chunk);
        });
        setIsRecording(true);
        setStatus("Recording...");
      } catch (error: any) {
        console.error("Failed to start recording:", error);
        setStatus(`Failed to start recording: ${error.message}`);
      }
    } else if (audioHandlerRef.current) {
      try {
        setStatus("Stopping recording...");
        audioHandlerRef.current.stopRecording();
        if (!useVAD) {
          const inputAudio = await clientRef.current?.commitAudio();
          await handleInputAudio(inputAudio!);
          await clientRef.current?.generateResponse();
        }
        setIsRecording(false);
        setStatus("");
      } catch (error: any) {
        console.error("Failed to stop recording:", error);
        setStatus(`Failed to stop recording: ${error.message}`);
      }
    }
  };

  // 初始化 useEffect
  useEffect(() => {
    // 防止重复初始化
    if (initRef.current) return;
    initRef.current = true;

    const initAudioHandler = async () => {
      const handler = new AudioHandler();
      await handler.initialize();
      audioHandlerRef.current = handler;
      await handleConnect();
      await toggleRecording();
    };

    initAudioHandler().catch((error: any) => {
      setStatus(`Initialization error: ${error.message}`);
      console.error(error);
    });

    return () => {
      if (isRecording) {
        toggleRecording();
      }
      audioHandlerRef.current?.close().catch(console.error);
      disconnect();
    };
  }, []);

  // 频率数据 useEffect
  useEffect(() => {
    let animationFrameId: number;

    if (isConnected && isRecording) {
      const animationFrame = () => {
        if (audioHandlerRef.current) {
          const freqData = audioHandlerRef.current.getByteFrequencyData();
          setFrequencies(freqData);
        }
        animationFrameId = requestAnimationFrame(animationFrame);
      };

      animationFrameId = requestAnimationFrame(animationFrame);
    } else {
      setFrequencies(undefined);
    }

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [isConnected, isRecording]);

  // 更新 session params
  useEffect(() => {
    clientRef.current?.configure({ voice });
  }, [voice]);
  useEffect(() => {
    clientRef.current?.configure({ temperature });
  }, [temperature]);

  // 关闭组件
  const handleClose = async () => {
    onClose?.();
    if (isRecording) {
      await toggleRecording();
    }
    disconnect().catch(console.error);
  };

  return (
    <div className={styles["realtime-chat"]}>
      <div
        className={clsx(styles["circle-mic"], {
          [styles["pulse"]]: isRecording,
        })}
      >
        <VoicePrint frequencies={frequencies} isActive={isRecording} />
      </div>
      {isConnecting && <Loading />} {/* 显示加载状态 */}
      <div className={styles["message-list"]}>
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`mb-2 ${
              msg.role === "user" ? "text-right" : "text-left"
            }`}
          >
            <div
              className={`inline-block rounded-lg py-2 px-4 ${
                msg.role === "user"
                  ? "bg-blue-500 text-white rounded-br-none"
                  : "bg-gray-200 rounded-bl-none"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
      </div>
      <div className={styles["bottom-icons"]}>
        <div>
          <IconButton
            icon={isRecording ? <VoiceIcon /> : <VoiceOffIcon />}
            onClick={toggleRecording}
            disabled={!isConnected || isConnecting} // 连接中禁用按钮
            shadow
            bordered
          />
        </div>
        <div className={styles["icon-center"]}>{status}</div>
        <div>
          <IconButton
            icon={<PowerIcon />}
            onClick={handleClose}
            shadow
            bordered
          />
        </div>
      </div>
    </div>
  );
}
