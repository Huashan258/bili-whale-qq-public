import {loadConfig} from '../src/config.mjs'
import {startLocalVoice} from '../src/local-voice-host.mjs'
try{console.log(JSON.stringify(await startLocalVoice(loadConfig())))}catch(e){console.error(e.message);process.exitCode=1}
