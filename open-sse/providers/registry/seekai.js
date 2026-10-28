export default {
  id: "seekai",
  alias: "ska",
  aliases: ["seek-ai"],
  uiAlias: "ska",
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  hasFree: true,
  display: {
    name: "SeekAi",
    icon: "hub",
    color: "#0D9488",
    textIcon: "SK",
    website: "https://seekai.cc",
    notice: {
      signupUrl: "https://seekai.cc",
      apiKeyUrl: "https://seekai.cc",
    },
  },
  passthroughModels: true,
  modelsFetcher: { url: "https://seekai.cc/v1/models", type: "openai" },
  transport: {
    baseUrl: "https://seekai.cc/v1/chat/completions",
    validateUrl: "https://seekai.cc/v1/models",
  },
  models: [],
};

