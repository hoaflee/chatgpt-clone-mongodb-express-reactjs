const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { titleConvo, askSydney } = require('../../app/');
const { saveMessage, saveConvo, getConvoTitle } = require('../../models');
const { handleError, sendMessage, createOnProgress, handleText } = require('./handlers');

router.post('/', async (req, res) => {
  const {
    model,
    text,
    overrideParentMessageId=null,
    parentMessageId,
    conversationId: oldConversationId,
    ...convo
  } = req.body;
  if (text.length === 0) {
    return handleError(res, { text: 'Prompt empty or too short' });
  }

  const conversationId = oldConversationId || crypto.randomUUID();
  const isNewConversation = !oldConversationId;

  const userMessageId = convo.messageId;
  const userParentMessageId = parentMessageId || '00000000-0000-0000-0000-000000000000';
  let userMessage = {
    messageId: userMessageId,
    sender: 'User',
    text,
    parentMessageId: userParentMessageId,
    conversationId,
    isCreatedByUser: true
  };

  console.log('ask log', {
    model,
    ...convo,
    ...userMessage
  });

  if (!overrideParentMessageId) {
    await saveMessage(userMessage);
    await saveConvo(req?.session?.user?.username, { model, ...convo, ...userMessage });
  }

  return await ask({
    isNewConversation,
    userMessage,
    model,
    convo,
    preSendRequest: true,
    overrideParentMessageId,
    req,
    res
  });
});

const ask = async ({
  isNewConversation,
  overrideParentMessageId = null,
  userMessage,
  model,
  convo,
  preSendRequest = true,
  req,
  res
}) => {
  let {
    text,
    parentMessageId: userParentMessageId,
    conversationId,
    messageId: userMessageId
  } = userMessage;

  res.writeHead(200, {
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });

  if (preSendRequest) sendMessage(res, { message: userMessage, created: true });

  try {
    const progressCallback = createOnProgress();

    const abortController = new AbortController();
    res.on('close', () => {
      console.log('The client has disconnected.');
      // 执行其他操作
      abortController.abort();
    })

    let response = await askSydney({
      text,
      onProgress: progressCallback.call(null, model, {
        res,
        text,
        parentMessageId: overrideParentMessageId || userMessageId
      }),
      convo: {
        ...convo,
        parentMessageId: userParentMessageId,
        conversationId
      },
      abortController
    });

    console.log('SYDNEY RESPONSE', response);
    // console.dir(response, { depth: null });

    userMessage.conversationSignature =
      convo.conversationSignature || response.conversationSignature;
    userMessage.conversationId = response.conversationId || conversationId;
    userMessage.invocationId = response.invocationId;
    userMessage.messageId = response.parentMessageId || userMessageId;
    // Unlike gpt and bing, Sydney will never accept our given userMessage.messageId, it will generate its own one.
    if (!overrideParentMessageId)
      await saveMessage({ oldMessageId: userMessageId, ...userMessage });

    // Save sydney response
    // response.id = response.messageId;
    response.invocationId = convo.invocationId ? convo.invocationId + 1 : 1;
    response.conversationId = conversationId ? conversationId : crypto.randomUUID();
    response.conversationSignature = convo.conversationSignature
      ? convo.conversationSignature
      : crypto.randomUUID();
    response.text = response.response || response.details.spokenText || '**Bing refused to answer.**';
    // delete response.response;
    response.suggestions =
      response.details.suggestedResponses &&
      response.details.suggestedResponses.map((s) => s.text);
    response.sender = model;
    // response.final = true;

    // override the parentMessageId, for the regeneration.
    response.parentMessageId =
      overrideParentMessageId || response.parentMessageId || userMessageId;

    // Save user message
    userMessage.conversationId = response.conversationId || conversationId;
    if (!overrideParentMessageId)
      await saveMessage(userMessage);

    // Bing API will not use our conversationId at the first time,
    // so change the placeholder conversationId to the real one.
    // Attition: the api will also create new conversationId while using invalid userMessage.parentMessageId,
    // but in this situation, don't change the conversationId, but create new convo.
    if (conversationId != userMessage.conversationId && isNewConversation)
      await saveConvo(
        req?.session?.user?.username,
        {
          conversationId: conversationId,
          newConversationId: userMessage.conversationId
        }
      );
    conversationId = userMessage.conversationId;

    response.text = await handleText(response, true);
    // Save sydney response & convo, then send
    await saveMessage(response);
    await saveConvo(req?.session?.user?.username, { model, chatGptLabel: null, promptPrefix: null, ...convo, ...response });
    
    sendMessage(res, {
      title: await getConvoTitle(req?.session?.user?.username, conversationId),
      final: true,
      requestMessage: userMessage,
      responseMessage: response
    });
    res.end();

    if (userParentMessageId == '00000000-0000-0000-0000-000000000000') {
      const title = await titleConvo({ model, text, response });

      await saveConvo(
        req?.session?.user?.username,
        {
          conversationId,
          title
        }
      );
    }
  } catch (error) {
    console.log(error);
    // await deleteMessages({ messageId: userMessageId });
    const errorMessage = {
      messageId: crypto.randomUUID(),
      sender: model,
      conversationId,
      parentMessageId: overrideParentMessageId || userMessageId,
      error: true,
      text: error.message
    };
    await saveMessage(errorMessage);
    handleError(res, errorMessage);
  }
};

module.exports = router;
