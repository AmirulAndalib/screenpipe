import { useRef, useState, useEffect } from "react";
import { Message, generateId } from "ai";
import { OpenAI } from "openai";
import { ChatMessage } from "@/components/chat-message";
import { useToast } from "@/components/ui/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, Send, Square, X, GripHorizontal, Bot } from "lucide-react";
import { StreamTimeSeriesResponse } from "@/app/page";
import { useTimelineSelection } from "@/lib/hooks/use-timeline-selection";
import { Agent } from "./agents";
import { pipe, type Settings } from "@screenpipe/browser";
import { useAiProvider } from "@/lib/hooks/use-ai-provider";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSettings } from "@/lib/hooks/use-settings";
import { ExportButton } from "../export-button";
import { AIPresetsSelector } from "../ai-presets-selector";
import { usePipeSettings } from "@/lib/hooks/use-pipe-settings";

interface AIPanelProps {
	position: { x: number; y: number };
	onPositionChange: (pos: { x: number; y: number }) => void;
	onClose: () => void;
	frames: StreamTimeSeriesResponse[];
	agents: Agent[];
	isExpanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
}

export function AIPanel({
	position,
	onPositionChange,
	onClose,
	frames,
	agents,
	isExpanded,
	onExpandedChange,
}: AIPanelProps) {
	const { settings } = useSettings();
	const { getPreset } = usePipeSettings("rewind");
	const [chatMessages, setChatMessages] = useState<Array<Message>>([]);
	const [isAiLoading, setIsAiLoading] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const [aiInput, setAiInput] = useState("");
	const [selectedAgent, setSelectedAgent] = useState<Agent>(agents[0]);
	const [isDraggingPanel, setIsDraggingPanel] = useState(false);
	const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
	const [chatWindowSize, setChatWindowSize] = useState({
		width: 400,
		height: 500,
	});
	const [osType, setOsType] = useState<string>("");

	const inputRef = useRef<HTMLInputElement>(null);
	const aiPanelRef = useRef<HTMLDivElement>(null);
	const resizerRef = useRef<HTMLDivElement | null>(null);
	const { toast } = useToast();
	const { selectionRange, setSelectionRange } = useTimelineSelection();
	const { isAvailable, error } = useAiProvider(settings);

	// Add abort controller ref
	const abortControllerRef = useRef<AbortController | null>(null);

	useEffect(() => {
		const detectOS = () => {
			// Try using modern API first
			if ("userAgentData" in navigator) {
				// @ts-ignore - userAgentData is not yet in all TypeScript definitions
				return navigator.userAgentData.platform;
			}
			// Fallback to user agent string parsing
			const userAgent = window.navigator.userAgent.toLowerCase();
			if (userAgent.includes("mac")) return "macos";
			if (userAgent.includes("win")) return "windows";
			if (userAgent.includes("linux")) return "linux";
			return "unknown";
		};

		setOsType(detectOS());
	}, []);

	const handlePanelMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
		e.preventDefault();
		setIsDraggingPanel(true);
		setDragOffset({
			x: e.clientX - position.x,
			y: e.clientY - position.y,
		});
	};

	useEffect(() => {
		const handleGlobalMouseMove = (e: MouseEvent) => {
			if (isDraggingPanel) {
				e.preventDefault();
				const newX = e.clientX - dragOffset.x;
				const newY = e.clientY - dragOffset.y;

				const maxX = window.innerWidth - chatWindowSize.width;
				const maxY = window.innerHeight - chatWindowSize.height;

				onPositionChange({
					x: Math.max(0, Math.min(maxX, newX)),
					y: Math.max(0, Math.min(maxY, newY)),
				});
			}
		};

		const handleGlobalMouseUp = () => {
			setIsDraggingPanel(false);
		};

		if (isDraggingPanel) {
			document.addEventListener("mousemove", handleGlobalMouseMove);
			document.addEventListener("mouseup", handleGlobalMouseUp);
		}

		return () => {
			document.removeEventListener("mousemove", handleGlobalMouseMove);
			document.removeEventListener("mouseup", handleGlobalMouseUp);
		};
	}, [
		isDraggingPanel,
		dragOffset,
		chatWindowSize.width,
		chatWindowSize.height,
		onPositionChange,
	]);

	// Add keyboard shortcut handler
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (
				(e.metaKey || e.ctrlKey) &&
				e.key.toLowerCase() === "l" &&
				!isExpanded
			) {
				e.preventDefault();
				onExpandedChange(true);
				setTimeout(() => {
					inputRef.current?.focus();
				}, 100);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isExpanded, onExpandedChange]);

	const handleMouseDown = (e: React.MouseEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startY = e.clientY;
		const startWidth = chatWindowSize.width;
		const startHeight = chatWindowSize.height;

		const handleMouseMove = (moveEvent: MouseEvent) => {
			const newWidth = Math.max(200, startWidth + moveEvent.clientX - startX);
			const newHeight = Math.max(200, startHeight + moveEvent.clientY - startY);
			setChatWindowSize({ width: newWidth, height: newHeight });
		};

		const handleMouseUp = () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
	};

	const handleAgentChange = (agentId: string) => {
		const newAgent = agents.find((a) => a.id === agentId) || agents[0];

		setSelectedAgent(newAgent);
	};

	const handleClose = () => {
		// Abort any ongoing request
		if (abortControllerRef.current) {
			abortControllerRef.current.abort();
			abortControllerRef.current = null;
		}
		setIsAiLoading(false);
		setIsStreaming(false);
		setChatMessages([]);
		setAiInput("");
		onClose();
		setSelectionRange(null);
	};

	const handleStopStreaming = () => {
		if (abortControllerRef.current) {
			abortControllerRef.current.abort();
			abortControllerRef.current = null;
			setIsStreaming(false);
			setIsAiLoading(false);
		}
	};

	const handleAiSubmit = async (e: React.FormEvent) => {
		pipe.captureMainFeatureEvent("rewind-ai-panel", {
			action: "ai-submit",
		});
		e.preventDefault();
		if (!selectionRange || !aiInput.trim()) return;

		// Create new abort controller for this request
		abortControllerRef.current = new AbortController();

		const userMessage = {
			id: generateId(),
			role: "user" as const,
			content: aiInput,
		};
		setChatMessages((prev) => [...prev, userMessage]);
		setAiInput("");
		setIsAiLoading(true);
		setIsStreaming(true);

		try {
			const relevantFrames = frames.reduce((acc, frame) => {
				const frameTime = new Date(frame.timestamp).getTime();
				const startTime = new Date(selectionRange.start).getTime();
				const endTime = new Date(selectionRange.end).getTime();
				const isInRange = frameTime >= startTime && frameTime <= endTime;

				if (!isInRange) return acc;

				// Get minute timestamp (rounded down to nearest minute)
				const minuteTimestamp = Math.floor(frameTime / 60000) * 60000;

				// Get unique apps in this frame
				const frameApps = new Set(
					frame.devices.map((device) => device.metadata.app_name),
				);

				// Check if we already have this app in this minute
				const existingFrameForMinute = acc.find((existing) => {
					const existingTime = new Date(existing.timestamp).getTime();
					const existingMinute = Math.floor(existingTime / 60000) * 60000;

					if (existingMinute !== minuteTimestamp) return false;

					// Check if apps are the same
					const existingApps = new Set(
						existing.devices.map((device) => device.metadata.app_name),
					);
					return (
						Array.from(frameApps).every((app) => existingApps.has(app)) &&
						Array.from(existingApps).every((app) => frameApps.has(app))
					);
				});

				// If we have multiple apps or haven't seen this app/minute combo, add the frame
				if (frameApps.size > 1 || !existingFrameForMinute) {
					acc.push(frame);
				}

				return acc;
			}, [] as StreamTimeSeriesResponse[]);

			// Sort frames by timestamp
			relevantFrames.sort(
				(a, b) =>
					new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
			);

			const aiPreset = getPreset();

			const openai = new OpenAI({
				apiKey: aiPreset?.apiKey,
				baseURL: aiPreset?.url,
				dangerouslyAllowBrowser: true,
			});

			let currentResponse = "";
			setChatMessages((prev) => [
				...prev,
				{ id: generateId(), role: "assistant", content: "" },
			]);

			await selectedAgent.analyze(
				relevantFrames,
				openai,
				{
					model: aiPreset?.model || "",
					onProgress: (chunk) => {
						currentResponse = chunk;
						setChatMessages((prev) => [
							...prev.slice(0, -1),
							{ id: generateId(), role: "assistant", content: currentResponse },
						]);
					},
					signal: abortControllerRef.current.signal,
				},
				aiInput,
			);
		} catch (error) {
			// Only show error if not aborted
			if (!(error instanceof Error && error.name === "AbortError")) {
				console.error("Error generating AI response:", error);
				toast({
					title: "error",
					description: "failed to generate AI response. please try again.",
					variant: "destructive",
				});
			}
		} finally {
			setIsAiLoading(false);
			setIsStreaming(false);
			abortControllerRef.current = null;
		}
	};

	if (!selectionRange) return null;

	return (
		<div
			ref={aiPanelRef}
			className="ai-panel bg-background border border-muted-foreground rounded-lg shadow-lg transition-all duration-300 ease-in-out z-10"
			style={{
				position: "fixed",
				left: position.x,
				top: position.y,
				width: chatWindowSize.width,
				height: isExpanded ? chatWindowSize.height : "auto",
				cursor: isDraggingPanel ? "grabbing" : "default",
			}}
		>
			<div
				className="select-none cursor-grab active:cursor-grabbing"
				onMouseDown={handlePanelMouseDown}
			>
				<div className="p-4 border-b border-muted-foreground flex justify-between items-center group">
					<div className="flex items-center gap-2 flex-1">
						<GripHorizontal className="w-4 h-4 text-muted-foreground group-hover:text-foreground" />
						<div className="text-muted-foreground text-xs">
							{new Date(selectionRange.start).toLocaleString([], {
								month: "short",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
								second: "2-digit",
							})}
							{" - "}
							{new Date(selectionRange.end).toLocaleString([], {
								month: "short",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
								second: "2-digit",
							})}
						</div>
					</div>
					<button
						onClick={handleClose}
						className="text-muted-foreground hover:text-foreground transition-colors ml-2"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{!isExpanded && (
					<div className="p-4 space-y-2">
						<button
							className="px-3 py-1 bg-background hover:bg-accent border text-foreground text-xs rounded flex items-center gap-2 transition-colors"
							onClick={(e) => {
								e.stopPropagation();
								onExpandedChange(true);
								setTimeout(() => {
									inputRef.current?.focus();
								}, 100);
							}}
						>
							<span>ask ai</span>
							<span className="text-muted-foreground text-[10px]">
								{osType === "macos" ? "⌘L" : "Ctrl+L"}
							</span>
						</button>
						<ExportButton />
					</div>
				)}
			</div>

			{isExpanded && (
				<div className="flex flex-col h-[calc(100%-52px)]">
					<div
						className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0 hover:cursor-auto text-foreground font-mono text-sm leading-relaxed "
						style={{
							WebkitUserSelect: "text",
							userSelect: "text",
							MozUserSelect: "text",
							msUserSelect: "text",
							overscrollBehavior: "contain",
							overflowY: "scroll",
							height: "100%",
							maxWidth: "100%",
							boxSizing: "border-box",
						}}
					>
						{chatMessages.map((msg, index) => (
							<ChatMessage key={index} message={msg} />
						))}
						{isAiLoading && (
							<div className="flex justify-center">
								<Loader2 className="h-6 w-6 animate-spin text-foreground" />
							</div>
						)}
					</div>

					<form
						onSubmit={handleAiSubmit}
						className="p-3 border-t border-muted-foreground"
					>
						<div className="flex flex-col gap-2">
							<div className="flex items-center gap-2">
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger>
											<Bot className="h-4 w-4 text-muted-foreground" />
										</TooltipTrigger>
										<TooltipContent>
											<p className="text-xs">using {settings?.aiModel}</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
								<select
									value={selectedAgent.id}
									onChange={(e) => handleAgentChange(e.target.value)}
									className="w-full bg-background border border-muted-foreground text-foreground rounded px-2 py-1 text-xs"
								>
									{agents.map((agent) => (
										<option
											key={agent.id}
											value={agent.id}
											className="bg-background text-foreground"
										>
											{agent.name} - {agent.description}
										</option>
									))}
								</select>
							</div>

							<div>
								<AIPresetsSelector pipeName="rewind" />
							</div>

							<div className="flex gap-2">
								<TooltipProvider>
									<Tooltip open={!isAvailable}>
										<TooltipTrigger asChild>
											<div className="flex-1">
												<Input
													ref={inputRef}
													type="text"
													value={aiInput}
													onChange={(e) => setAiInput(e.target.value)}
													placeholder="ask about this time range..."
													className="flex-1 bg-background border border-muted-foreground text-foreground placeholder-muted-foreground"
													disabled={isAiLoading || !isAvailable}
												/>
											</div>
										</TooltipTrigger>
										<TooltipContent side="top">
											<p className="text-sm text-destructive">{error}</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
								<Button
									type="submit"
									variant="outline"
									className="hover:bg-accent transition-colors"
									disabled={!isAvailable}
									onClick={isStreaming ? handleStopStreaming : handleAiSubmit}
								>
									{isStreaming ? (
										<Square className="h-4 w-4" />
									) : (
										<Send className="h-4 w-4" />
									)}
								</Button>
							</div>
						</div>
					</form>
				</div>
			)}

			<div
				ref={resizerRef}
				onMouseDown={handleMouseDown}
				className="absolute right-0 bottom-0 w-4 h-4 cursor-se-resize bg-transparent"
				style={{
					borderTopLeftRadius: "4px",
					borderBottomRightRadius: "4px",
					cursor: "se-resize",
				}}
			/>
		</div>
	);
}
