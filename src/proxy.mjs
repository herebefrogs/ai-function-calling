import OpenAI from "openai";
import express from "express";
import { Ajv } from "ajv";
import { default as API_KEYS } from "../api-keys.json" with { type: "json" };
import { ValidationError } from "./errors.mjs";

const app = express();
app.use(express.static("www"));
app.use(express.json()) // for parsing req.body when mine type is application/json


// AI clients

const openai = new OpenAI({ apiKey: API_KEYS.OPENAI });

const CONFIG = {
  OLLAMA: {
    ENDPOINT: process.env.RUNPOD_ID ? `https://${process.env.RUNPOD_ID}-11434.proxy.runpod.net` : "http://localhost:11434",
  }
}

const OLLAMA = {
  // options must contain at least model and messages
  chat: async (options) => {
    const response = await request(CONFIG.OLLAMA.ENDPOINT + "/v1/chat/completions", "post", { stream: false, ...options });
    return response.choices[response.choices.length - 1].message.content;
  },
  // options must contain at least model and prompt
  generate: async (options) => {
    const response = await request(CONFIG.OLLAMA.ENDPOINT + "/api/generate", "post", { stream: false, ...options });
    return response.response;
  }
}

// 3rd party APIs function calls

const FUNCTION_CALLS = {
  // Open-Notify: ISS location and people in space
  getISSLocation: {
    callback: async () => await request("http://api.open-notify.org/iss-now.json"),
    description: "getISSLocation() -> dict - Get the current location of the International Space Station\n\n   Args:\n   None\n\n   Returns:\n   dict: A dictionary containing the latitude and longitude of the ISS",
    properties: {},
    required: []
  },
  getPeopleInSpace: {
    callback: async () => await request("http://api.open-notify.org/astros.json"),
    description: "getPeopleInSpace() -> dict - Get the number and name of people currently in space\n\n   Args:\n   None\n\n   Returns:\n   dict: A dictionary containing the number of people and their names",
    properties: {},
    required: []
  },
  // Nominatin API: Reverse Geocoding
  getCityByCoordinates: {
    callback: async ({ latitude, longitude }) => await request(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=10`),
    description: "getCityByCoordinates(lat: number, long: number) -> dict - Get the city, county, state and country by latitude and longitude coordinates\n\n   Args:\n   lat (number): The latitude coordinate\n   long (number): The longitude coordinate\n\n   Returns:\n   dict: A dictionary containing the city, county, state and country",
    properties: {
      // accepts -15.26 or "-15.26" as valid values (unfortunately, that will also accept "<$issLocation.lat>" but this seems easier for models to recover from than a TypeError
      latitude: { type: ['number', 'string' ] },
      longitude: { type: ['number', 'string' ] }
    },
    required: ['latitude', 'longitude']
  },
  // Tomorrow.io: Realtime weather data
  getWeatherByCoordinates: {
    callback: async ({ latitude, longitude }) => await request(`https://api.tomorrow.io/v4/weather/realtime?location=${latitude},${longitude}&units=metric&apikey=${API_KEYS.TOMORROW_IO}`),
    description: "getWeatherByCoordinates(lat: number, long: number) -> Get the temperature and weather code by latitude and longitude coordinates\n\n   Args:\n   lat (number): The latitude coordinate\n   long (number): The longitude coordinate\n\n   Returns:\n   dict: A dictionary containing the temperature and weather code",
    properties: {
      latitude: { type: ['number', 'string' ] },
      longitude: { type: ['number', 'string' ] }
    },
    required: ['latitude', 'longitude']
  }
};

// Utils

async function request(endpoint, method = "get", params, apiKey) {
  console.debug('request', endpoint, method, params, apiKey);

  const options = { method, headers: { "Content-Type": "application/json" }};
  if (apiKey) {
    options.headers["Authorization"] = `Bearer ${apiKey}`;
  }
  if (params) {
    options['body'] = JSON.stringify(params);
  }

  const response = await fetch(endpoint, options);
  const data = await response.json();
  console.debug('response', data);

  return data;
}

const formatTools = () => Object.entries(FUNCTION_CALLS).map(([name, { description, required, properties }]) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required
    }
  }
}));

const formatChatML = (messages) => messages.map(({ role, content }) => `<|im_start|>${role}\n${content}<|im_end|>`).join("\n");

const formatToolResponse = (response) => `<tool_response>${JSON.stringify(response)}</tool_response>`;

const sanitizeToolcall = tool_call => console.debug({tool_call}) || JSON.parse(tool_call.replace(/\n/, "").trim().replace(/'/g, "\""));

const pluckArgumentValues = (args, values) => Object.keys(args).reduce((acc, key) => { acc[key] = values[key]; return acc; }, {});


const callOpenAI = async (messages, abortAfter = 10) => {
  if (abortAfter <= 0) {
    // if parameters aren't passed properly to external APIs, the conversation can get into an endless loop
    return messages;
  }

  let response = await openai.chat.completions.create({ model: "gpt-4-turbo-preview", messages, tools: formatTools() });
  console.debug('assistant response', response.choices[0].message);

  messages.push(response.choices[0].message);

  const toolCalls = [];

  if (response.choices[0].finish_reason === "tool_calls") {
    toolCalls.push(...response.choices[0].message.tool_calls);

    try {
      // NOTE: GPT4 is excellent at splitting nested function calls as separate messages so it can use the values of one as arguments for the next
      // so we can process all function calls requested in the response with reasonable confidence they won't fail
      while (toolCalls.length) {
        const toolCall = toolCalls.shift();
        console.debug('tool call', toolCall);

        const tool_call_id = toolCall.id;
        const name = toolCall.function.name;
  
        const argumentsValues = JSON.parse(toolCall.function.arguments);

        const callFunction = FUNCTION_CALLS[name];
  
        if (!callFunction) {
          // log error for the model to consider
          messages.push({ tool_call_id, role: "tool", content: JSON.stringify({ error: { type: "function check", message: `Function ${name} not found` } }) });
          continue;
        }
  
        if (!callFunction.validate(argumentsValues)) {
          // log error for the model to consider
          messages.push({ tool_call_id, role: "tool", content: JSON.stringify({ error: { type: "arguments check", message: callFunction.validate.errors } }) });
          continue;
        }
  
        // execute function call
        response = await callFunction.callback.apply(null, pluckArgumentValues(callFunction.schema.properties, argumentsValues));
  
        // log response
        messages.push({ tool_call_id, role: "tool", name, content: JSON.stringify(response) });
      }
    } catch (e) {
      // log error for the model to consider
      messages.push({ role: "user", content: JSON.stringify({ error: { type: e.name, message: e.message } }) });
    }

    // call AI model again with function call responses
    messages = callOpenAI(messages, abortAfter - 1);
  }

  // no more function call(s) needed, return the whole conversation with the assistant's final answer
  return messages;
}


const callOllama = async (model, messages, abortAfter = 10) => {
  if (abortAfter <= 0) {
    // if parameters aren't passed properly to external APIs, the conversation can get into an endless loop
    return messages;
  }

  // call AI model with user prompt and previous messages
  let response = await OLLAMA.generate({ model, prompt: formatChatML(messages) });
  console.debug('assistant response', response);

  // check if response requests some function call(s)
  const toolCalls = [...response.matchAll(/<tool_call>\n(.*?)\n<\/tool_call>/gs)];

  if (!toolCalls.length) {
    messages.push({ role: "assistant", content: response });
  } else {
    // NOTE: unfortunately, Hermes2 and Mistral models don't split nested function calls as separate messages, so the function calls
    // dependent on previous ones tend to have hallucinated variables in place of values and can't be executed or even parsed.
    // to break down the models' reasoning, only process the first function call so the other ones will be requested again later with the correct values
    const [match, captureGroup] = toolCalls[0];
    
    // log first function call
    messages.push({ role: "assistant", content: match });
    
    try {
      const { name, arguments: argumentsValues } = sanitizeToolcall(captureGroup);
      const callFunction = FUNCTION_CALLS[name];

      // log errors for the model to consider
      if (!callFunction) {
        throw new SyntaxError(`Function ${name} not found`);
      }
      
      if (!callFunction.validate(argumentsValues)) {
        throw new ValidationError(callFunction.validate.errors);
      }

      // execute function call
      const sanitizedArguments = pluckArgumentValues(callFunction.properties, argumentsValues);
      console.debug({ sanitizedArguments});
      response = await callFunction.callback(sanitizedArguments);

      // log response
      messages.push({ role: "tool", content: formatToolResponse(response) });
    
    } catch (e) {
      console.error(e);
      // log error for the model to consider
      messages.push({ role: "tool", content: formatToolResponse({ error: { type: e.name, message: e.message } }) });
    }
    
    // call AI model again with function call responses
    messages = await callOllama(model, messages, abortAfter - 1);
  }

  // no more function call(s) needed, return the whole conversation with the assistant's final answer
  return messages;
}

// Proxy Endpoints

app.post("/function/call", async (req, res) => {
  const { model, prompt } = req.body;

  let messages = [];
 
  switch(model) {
    case "gpt4":
      messages = await callOpenAI([
        { role: "system", content: "You are a function calling AI model. You may make one or more function calls to assist users with their query. Don't make assumptions about what values to plug into functions." },
        { role: "user", content: prompt }
      ])
      break;
  case "hermes2promistral":
  case "hermes2prollama3":
  case "mistral:instruct":
    messages = await callOllama(model, [
      {
        role: "system",
        content: `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. \
Break down your reasoning into separate step and perform only one function call per step. Don't make assumptions about the values you plug into functions. Here are the available tools:\n <tools>\n${JSON.stringify(formatTools())}\n</tools>\n\
Use the pydantic model JSON schema for each tool call you will make: \
{'title': 'FunctionCall', 'type': 'object', 'properties': {'arguments': {'title': 'Arguments', 'type': 'object'}, 'name': {'title': 'Name', 'type': 'string'}}, 'required': ['argument', 'name']} \
For each function call return a JSON object with function name and arguments within <tool_call></tool_call> XML tags as follows:\n \
<tool_call>\n \
{"name": "FUNCTION_NAME", "arguments": "ARGS_DICT" }\n \
</tool_call>\n`
      },
      { role: "user", content: prompt }
    ]);
    break;  
  }

  res.json({ messages });
});


// precompile a schema validator for each public API function call

const jsonValidator = new Ajv();
Object.values(FUNCTION_CALLS).forEach(f => {
  const { description, properties, required } = f;
  f.validate = jsonValidator.compile({ description, properties, required });
});

// Start the server

app.listen(8000, () => {
  console.log('available tools', JSON.stringify(formatTools()));
  console.log('OLLAMA endpoint:', CONFIG.OLLAMA.ENDPOINT);
  console.log('Server running on http://localhost:8000')
});

