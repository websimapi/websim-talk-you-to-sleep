const { useState, useEffect, useSyncExternalStore, useRef, useCallback } = React;
const { ClipLoader } = ReactSpinners;

const room = new WebsimSocket();

// --- Initial Voice Setup ---
const INITIAL_VOICES = [
    { name: 'Soothe', file: 'voice_sample_1.mp3' },
    { name: 'Whisper', file: 'voice_sample_2.mp3' },
    { name: 'Calm', file: 'voice_sample_3.mp3' },
];

async function setupInitialVoices() {
    const voices = room.collection('voice_v1').getList();
    if (voices.length >= INITIAL_VOICES.length) {
        console.log("Voices already initialized.");
        return;
    }
    console.log("Initializing voices...");
    for (const voice of INITIAL_VOICES) {
        const existing = voices.find(v => v.name === voice.name);
        if (!existing) {
            try {
                const response = await fetch(voice.file);
                const blob = await response.blob();
                const file = new File([blob], voice.file, { type: blob.type });
                const url = await websim.upload(file);
                await room.collection('voice_v1').create({ name: voice.name, url });
                console.log(`Created voice: ${voice.name}`);
            } catch (error) {
                console.error(`Failed to initialize voice ${voice.name}:`, error);
            }
        }
    }
}
setupInitialVoices();

// --- Main App Component ---
function App() {
    const voices = useSyncExternalStore(room.collection('voice_v1').subscribe, room.collection('voice_v1').getList);
    const messages = useSyncExternalStore(room.collection('message_v1').subscribe, room.collection('message_v1').getList);
    
    const [selectedVoice, setSelectedVoice] = useState(null);
    const [userInput, setUserInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [status, setStatus] = useState("Select a voice to begin.");
    const [isListening, setIsListening] = useState(false);

    const intervalRef = useRef(null);
    const audioRef = useRef(null);
    const chatAreaRef = useRef(null);
    const recognitionRef = useRef(null);

    const stopTalking = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }
        setStatus("Paused. Select a voice to resume.");
    }, []);
    
    useEffect(() => {
        // Cleanup on unmount
        return () => {
            stopTalking();
            if(recognitionRef.current) {
                recognitionRef.current.stop();
            }
        };
    }, [stopTalking]);

    const generateAndPlayResponse = useCallback(async (isUserInitiated = false) => {
        if (isLoading) return;
        setIsLoading(true);
        setStatus("Thinking...");
        
        let lastUserMessage = null;
        if(isUserInitiated) {
            const userMessages = messages.filter(m => m.role === 'user').sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            lastUserMessage = userMessages[0] || null;
        }

        const systemPrompt = `You are a gentle, soothing AI assistant. Your purpose is to talk someone to sleep.
- Your voice is very soft and calm.
- Use short, simple sentences.
- Speak slowly. Introduce pauses.
- Topics: peaceful scenery, gentle thoughts, relaxing body scans, quiet affirmations.
- If the user says something, gently acknowledge it and weave it into the peaceful narrative. Don't ask questions back. Guide the conversation back to relaxation.
- If there is no user input, continue with a calming monologue.
- Do not use markdown or emojis.`;

        const conversationHistory = messages
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
            .slice(-10)
            .map(m => ({ role: m.role, content: m.text }));

        try {
            const completion = await websim.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    ...conversationHistory,
                ],
            });
            const textResponse = completion.content;
            
            await room.collection('message_v1').create({ role: 'ai', text: textResponse });
            
            setStatus("Generating audio...");
            const ttsResult = await websim.textToSpeech({
                text: textResponse,
                voice_sample: selectedVoice.url,
            });

            audioRef.current = new Audio(ttsResult.url);
            audioRef.current.play();
            setStatus("Speaking...");
            audioRef.current.onended = () => {
                if(intervalRef.current) setStatus("Quietly waiting...");
            };

        } catch (error) {
            console.error("Error in generation loop:", error);
            setStatus("An error occurred. Please try again.");
        } finally {
            setIsLoading(false);
        }
    }, [messages, isLoading, selectedVoice]);

    const startTalking = useCallback((voice) => {
        stopTalking();
        setSelectedVoice(voice);
        setStatus("Starting session...");
        
        // Initial message
        setTimeout(() => generateAndPlayResponse(false), 1000);

        // Set up interval
        intervalRef.current = setInterval(() => {
            generateAndPlayResponse(false);
        }, 15000);
    }, [stopTalking, generateAndPlayResponse]);
    
    const handleSend = async () => {
        if (!userInput.trim() || !selectedVoice) return;
        const text = userInput;
        setUserInput('');
        await room.collection('message_v1').create({ role: 'user', text });
        // Immediately trigger a response instead of waiting for the interval
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
        }
        generateAndPlayResponse(true);
        intervalRef.current = setInterval(() => {
            generateAndPlayResponse(false);
        }, 15000);
    };

    const handleMicClick = () => {
        if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
            alert("Speech recognition is not supported in your browser.");
            return;
        }
        if (!selectedVoice) {
            alert("Please select a voice first.");
            return;
        }

        if (isListening) {
            recognitionRef.current.stop();
            setIsListening(false);
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognitionRef.current = new SpeechRecognition();
        recognitionRef.current.continuous = false;
        recognitionRef.current.interimResults = false;
        recognitionRef.current.lang = 'en-US';

        recognitionRef.current.onstart = () => {
            setIsListening(true);
            setStatus("Listening...");
        };
        
        recognitionRef.current.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            setUserInput(transcript);
            // Automatically send after successful recognition
            if (transcript.trim()) {
              room.collection('message_v1').create({ role: 'user', text: transcript }).then(() => {
                setUserInput('');
                if (intervalRef.current) clearInterval(intervalRef.current);
                generateAndPlayResponse(true);
                intervalRef.current = setInterval(() => generateAndPlayResponse(false), 15000);
              });
            }
        };

        recognitionRef.current.onerror = (event) => {
            console.error("Speech recognition error", event.error);
            setStatus(`Mic error: ${event.error}`);
        };

        recognitionRef.current.onend = () => {
            setIsListening(false);
            if(!isLoading) setStatus("Quietly waiting...");
        };

        recognitionRef.current.start();
    };

    const sortedMessages = [...messages].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    return (
        <>
            <h1>Talk You To Sleep</h1>
            <h2>Choose a voice to begin your relaxation session</h2>
            <div className="voice-selector">
                {voices.length === 0 && <ClipLoader color="#b0c4de" size={20} />}
                {voices.map(voice => (
                    <button 
                        key={voice.id} 
                        className={`voice-button ${selectedVoice?.id === voice.id ? 'selected' : ''}`}
                        onClick={() => startTalking(voice)}
                    >
                        {voice.name}
                    </button>
                ))}
            </div>
            
            <div className="chat-area" ref={chatAreaRef}>
                 <div className="message-container">
                    {sortedMessages.map(msg => (
                        <div key={msg.id} className={`message ${msg.role}`}>
                            {msg.text}
                        </div>
                    ))}
                </div>
            </div>

            <div className="status">
                {isLoading && <ClipLoader color="#ecf0f1" size={15} />}
                <span>{status}</span>
            </div>

            <div className="input-area">
                <input 
                    type="text"
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                    placeholder="You can type here..."
                    disabled={!selectedVoice || isLoading}
                />
                 <button 
                    className={`mic-button ${isListening ? 'listening' : ''}`}
                    onClick={handleMicClick}
                    disabled={!selectedVoice || isLoading}
                    title="Talk"
                >
                    {isListening ? '...' : '🎤'}
                </button>
                <button onClick={handleSend} disabled={!selectedVoice || isLoading}>Send</button>
            </div>
        </>
    );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

