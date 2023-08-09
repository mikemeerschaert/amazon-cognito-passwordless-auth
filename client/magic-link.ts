/**
 * Copyright Amazon.com, Inc. and its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"). You
 * may not use this file except in compliance with the License. A copy of
 * the License is located at
 *
 *     http://aws.amazon.com/apache2.0/
 *
 * or in the "license" file accompanying this file. This file is
 * distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for the specific
 * language governing permissions and limitations under the License.
 */
import { IdleState, BusyState, busyState, TokensFromSignIn } from "./model.js";
import { defaultTokensCb } from "./common.js";
import {
  assertIsChallengeResponse,
  assertIsAuthenticatedResponse,
  initiateAuth,
  respondToAuthChallenge,
  Session,
} from "./cognito-api.js";
import {
  parseJwtPayload,
  currentBrowserLocationWithoutFragmentIdentifier,
  removeFragmentIdentifierFromBrowserLocation,
  bufferFromBase64Url,
} from "./util.js";
import { configure } from "./config.js";
import { CognitoIdTokenPayload } from "./jwt-model.js";

export const requestSignInLink = ({
  usernameOrAlias,
  redirectUri,
  currentStatus,
  statusCb,
}: {
  usernameOrAlias: string;
  redirectUri?: string;
  currentStatus?: BusyState | IdleState;
  statusCb?: (status: BusyState | IdleState) => void;
}) => {
  const { clientId, storage, debug } = configure();
  if (currentStatus && busyState.includes(currentStatus as BusyState)) {
    throw new Error(
      `Can't request sign-in link while in status ${currentStatus}`
    );
  }
  statusCb?.("REQUESTING_SIGNIN_LINK");
  const abort = new AbortController();
  const signInLinkRequested = (async () => {
    try {
      let res = await initiateAuth({
        authflow: "CUSTOM_AUTH",
        authParameters: {
          USERNAME: usernameOrAlias,
        },
        abort: abort.signal,
      });
      assertIsChallengeResponse(res);
      const username = res.ChallengeParameters.USERNAME;
      res = await respondToAuthChallenge({
        challengeName: "CUSTOM_CHALLENGE",
        challengeResponses: {
          ANSWER: "__dummy__",
          USERNAME: usernameOrAlias,
        },
        clientMetadata: {
          signInMethod: "MAGIC_LINK",
          redirectUri: redirectUri || currentBrowserLocationWithoutFragmentIdentifier(),
          alreadyHaveMagicLink: "no",
        },
        session: res.Session,
        abort: abort.signal,
      });
      assertIsChallengeResponse(res);
      if (username && res.Session) {
        await storage.setItem(
          `Passwordless.${clientId}.${username}.session`,
          res.Session
        );
      }
      statusCb?.("SIGNIN_LINK_REQUESTED");
      return res.Session;
    } catch (err) {
      debug?.(err);
      currentStatus && statusCb?.("SIGNIN_LINK_REQUEST_FAILED");
      throw err;
    }
  })();
  return {
    signInLinkRequested,
    abort: () => abort.abort(),
  };
};

const failedFragmentIdentifieres = new Set<string>();
function checkCurrentLocationForSignInLink() {
  const { debug } = configure();
  let url: URL;
  let fragmentIdentifier: string;
  try {
    url = new URL(window.location?.href);
    fragmentIdentifier = url.hash?.slice(1);
    if (!fragmentIdentifier) {
      debug?.(
        "Current location.href has no fragment identifier, nothing to do"
      );
      return;
    }
    if (failedFragmentIdentifieres.has(fragmentIdentifier)) {
      debug?.(
        "Current location.href has a fragment identifier that failed before, ignoring"
      );
      return;
    }
  } catch (e) {
    // TODO Implement DeepLinks for React Native MagicLink Support
    debug?.("Couldn't parse location url");
    return;
  }
  const header = fragmentIdentifier.split(".")[0];
  let message: unknown;
  try {
    debug?.("Parsing magic link header:", header);
    message = JSON.parse(new TextDecoder().decode(bufferFromBase64Url(header)));
    debug?.("Magic link header parsed:", message);
    assertIsMessage(message);
  } catch (err) {
    debug?.("Ignoring invalid fragment identifier");
    return;
  }
  if (!message.userName || typeof message.userName !== "string") {
    debug?.(
      `Ignoring fragment identifier with invalid username:`,
      message.userName
    );
    return;
  }
  if (!message.exp || typeof message.exp !== "number") {
    debug?.(`Ignoring fragment identifier with invalid exp:`, message.userName);
    return;
  }
  return {
    username: message.userName,
    exp: message.exp,
    fragmentIdentifier,
  };
}

function assertIsMessage(
  msg: unknown
): asserts msg is { userName: string; exp: number; iat: number } {
  if (
    !msg ||
    typeof msg !== "object" ||
    !("userName" in msg) ||
    typeof msg.userName !== "string" ||
    !("exp" in msg) ||
    typeof msg.exp !== "number" ||
    !("iat" in msg) ||
    typeof msg.iat !== "number"
  ) {
    throw new Error("Invalid magic link");
  }
}

async function authenticateWithSignInLink({
  usernameOrAlias,
  fragmentIdentifier,
  currentStatus,
  clientMetadata,
  session,
  abort,
}: {
  usernameOrAlias: string;
  fragmentIdentifier: string;
  currentStatus?: BusyState | IdleState;
  clientMetadata?: Record<string, string>;
  session?: Session;
  abort?: AbortSignal;
}): Promise<TokensFromSignIn> {
  const { clientId, storage, debug } = configure();
  if (currentStatus && busyState.includes(currentStatus as BusyState)) {
    throw new Error(
      `Can't authenticate with link while in status ${currentStatus}`
    );
  }
  session ??=
    (await storage.getItem(
      `Passwordless.${clientId}.${usernameOrAlias}.session`
    )) ?? undefined;
  await storage.removeItem(
    `Passwordless.${clientId}.${usernameOrAlias}.session`
  );
  if (!session) {
    debug?.(`Invoking initiateAuth ...`);
    const initAuthResponse = await initiateAuth({
      authflow: "CUSTOM_AUTH",
      authParameters: {
        USERNAME: usernameOrAlias,
      },
      abort,
    });
    assertIsChallengeResponse(initAuthResponse);
    debug?.(`Response from initiateAuth:`, initAuthResponse);
    session = initAuthResponse.Session;
  } else {
    debug?.(`Continuing authentication using session: ${session}`);
  }
  debug?.(`Invoking respondToAuthChallenge ...`);
  const authResult = await respondToAuthChallenge({
    challengeName: "CUSTOM_CHALLENGE",
    challengeResponses: {
      ANSWER: fragmentIdentifier,
      USERNAME: usernameOrAlias,
    },
    clientMetadata: {
      ...clientMetadata,
      signInMethod: "MAGIC_LINK",
      redirectUri: currentBrowserLocationWithoutFragmentIdentifier(),
      alreadyHaveMagicLink: "yes",
    },
    session: session,
    abort,
  });
  assertIsAuthenticatedResponse(authResult);
  debug?.(`Response from respondToAuthChallenge:`, authResult);
  return {
    accessToken: authResult.AuthenticationResult.AccessToken,
    idToken: authResult.AuthenticationResult.IdToken,
    refreshToken: authResult.AuthenticationResult.RefreshToken,
    expireAt: new Date(
      Date.now() + authResult.AuthenticationResult.ExpiresIn * 1000
    ),
    username: parseJwtPayload<CognitoIdTokenPayload>(
      authResult.AuthenticationResult.IdToken
    )["cognito:username"],
  };
}

export const signInWithLink = (props?: {
  session?: Session;
  tokensCb?: (tokens: TokensFromSignIn) => void | Promise<void>;
  statusCb?: (status: BusyState | IdleState) => void;
}) => {
  const { debug } = configure();
  const abort = new AbortController();
  const { statusCb, tokensCb } = props ?? {};
  const signedIn = (async () => {
    const params = checkCurrentLocationForSignInLink();
    if (!params) {
      statusCb?.("NO_SIGNIN_LINK");
      return;
    }
    if (params.exp < Date.now() / 1000) {
      statusCb?.("SIGNIN_LINK_EXPIRED");
      return;
    }
    statusCb?.("SIGNING_IN_WITH_LINK");
    try {
      const tokens = await authenticateWithSignInLink({
        usernameOrAlias: params.username,
        fragmentIdentifier: params.fragmentIdentifier,
        session: props?.session,
        abort: abort.signal,
      }).catch((err) => {
        if (
          err instanceof Error &&
          err.message?.includes("Incorrect username or password")
        ) {
          debug?.(err);
          statusCb?.("SIGNIN_LINK_EXPIRED");
          return;
        }
        throw err;
      });
      if (!tokens) return;
      removeFragmentIdentifierFromBrowserLocation();
      tokensCb
        ? await tokensCb(tokens)
        : await defaultTokensCb({ tokens, abort: abort.signal });
      statusCb?.("SIGNED_IN_WITH_LINK");
      return tokens;
    } catch (err) {
      failedFragmentIdentifieres.add(params.fragmentIdentifier);
      statusCb?.("INVALID_SIGNIN_LINK");
      throw err;
    }
  })();
  return {
    signedIn,
    abort: () => abort.abort(),
  };
};
