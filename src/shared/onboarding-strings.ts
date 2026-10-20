// Every word the v0.4.0 first run puts on screen, in one place (docs/ONBOARDING-v0.4.0.md, §2 and §4).
//
// THREE NAMESPACES, and the lint reads only the first:
//   main      the path someone with no technical background walks. Held to ./onboarding-banned-words.json
//             (smoke:onboarding-copy), and its rendered text is held to the same list by
//             scripts/onboarding-welcome-probe.mjs.
//   advanced  behind an "Advanced" link, for people who know the words. Exempt.
//   dev       stand-ins that only a dev or probe build can reach (the gate: ./onboarding-gate). Exempt.
//
// A string that is not here is not on a main-path screen: components import this, they do not type
// prose. The probe catches the ones that slip through by reading the DOM.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export const COPY = {
  main: {
    common: {
      back: 'Back',
      continue: 'Continue',
      help: 'Need help?',
      // The signpost to the Advanced screens: plain, because it sits on a main-path screen. What it opens may
      // use the technical words.
      advanced: 'Advanced',
      recommended: 'Recommended'
    },
    w1: {
      title: 'Welcome to Beacon',
      body: "Beacon is the app you chat in. Prometheus is your assistant's brain. It runs on a computer you own, so your conversations stay with you.",
      pace: "Let's get you to your first chat. It takes about five minutes.",
      start: 'Get started',
      guide: 'Read the setup guide'
    },
    w2: {
      title: 'Do you already have Prometheus?',
      body: 'Prometheus is the part that does the thinking. Beacon needs one to talk to.',
      choicesLabel: 'Where is Prometheus?',
      new: {
        title: 'No, set it up on this Mac',
        detail: "Beacon gets Prometheus for you and sets it up. You won't need to type any commands."
      },
      existing: {
        title: 'Yes, connect to it',
        detail: 'Prometheus is already running on this Mac or another computer you use.',
        detailFound: 'We found {name} running on this Mac.'
      },
      // 0.4.2: offered once a Prometheus has answered on this Mac, beside connecting to it.
      another: {
        title: 'Look for another computer',
        detail: 'Beacon looks on your home network for Prometheus on another computer.'
      },
      looking: {
        title: "I'm just looking",
        detail: 'See what Beacon does first. You can set it up later.'
      }
    },
    c1: {
      title: "Here's what Beacon does",
      cards: [
        { title: 'Chat with your assistant', detail: 'Ask questions, plan things, write and edit.' },
        { title: 'Watch it work', detail: 'See each step it takes while it helps you.' },
        { title: 'You stay in charge', detail: 'It asks before doing anything important, and you approve or decline.' }
      ],
      setItUp: 'Set it up',
      website: 'Visit the website',
      notNow: 'Not now'
    },
    unconnected: {
      title: "Beacon isn't connected yet",
      body: 'Connect it to Prometheus to start chatting.',
      setItUp: 'Set it up'
    },
    // Path B (docs/ONBOARDING-v0.4.0.md §4). {name} and {agent} are filled with what a computer says about
    // itself, cleaned (@shared/discovery); the lint reads the templates, never what is poured into them.
    b1: {
      title: 'Let Beacon look on your network',
      body: 'Beacon looks for Prometheus on this Mac and your home network. Your Mac will ask for permission next. Choose Allow.',
      reassure: "Looking doesn't connect you to anything. You'll approve every connection."
    },
    b2: {
      title: 'Looking for Prometheus…',
      body: 'Checking this Mac and your home network. This takes a few seconds.'
    },
    b3: {
      title: 'Choose your Prometheus',
      titleOne: 'We found {name}',
      body: 'We found Prometheus on these computers.',
      listLabel: 'Computers running Prometheus',
      thisMac: 'This Mac',
      where: { 'this-mac': 'running here', 'home-network': 'on your home network', 'private-network': 'on your private network' },
      connect: 'Connect',
      notSeeing: "Don't see it?",
      different: 'This looks different from last time'
    },
    bEmpty: {
      title: "We couldn't find Prometheus",
      intro: "Here's what usually causes this:",
      asleep: 'The computer running Prometheus is asleep or turned off.',
      wifi: 'This Mac is on a different Wi-Fi network from it.',
      denied: "Beacon isn't allowed to look on your network.",
      deniedTitle: "Beacon isn't allowed to look on your network",
      howToAllow: 'macOS asked, and Beacon was told no. To allow it, open System Settings, then Privacy & Security, then Local Network, and turn on Beacon. Then look again.',
      outdatedTitle: '{name} needs an update',
      outdatedBody: "Beacon found it, but it can't connect to it safely yet. Update Prometheus on that computer and turn on home network, then look again.",
      openSettings: 'Open Settings',
      lookAgain: 'Look again',
      setUpHere: 'Set it up on this Mac instead'
    },
    // Path A (docs/ONBOARDING-v0.4.0.md §4): the check of this Mac, and the one confirmation. {free} and {size} are
    // numbers Beacon measured or was told, never a computer's words.
    a1: {
      checking: { title: 'Checking this Mac…', body: 'Making sure Prometheus will run well here. This takes a moment.' },
      lowSpace: { title: 'This Mac needs more free space.', body: 'Prometheus needs about 2 GB; this Mac has {free} free.', openStorage: 'Open Storage settings', checkAgain: 'Check again' },
      oldMacos: { title: 'This Mac needs a newer macOS.', body: 'Prometheus needs macOS 13 or later.', howToUpdate: 'How to update' },
      intel: {
        title: 'This Mac has an Intel chip.',
        body: 'Prometheus for Mac needs Apple silicon (M1 or later). You can still use Beacon with Prometheus on another computer.',
        elsewhere: 'Connect to another computer'
      },
      otherOs: {
        title: "Setting up isn't available on this computer yet.",
        body: 'Beacon can set up Prometheus on a Mac with Apple silicon. You can still use Beacon with Prometheus on another computer.'
      },
      running: { title: 'Prometheus is already on this Mac.', body: 'Connect to it instead of setting it up again.', connect: 'Connect to it' }
    },
    aConfirm: {
      title: 'Set up Prometheus on this Mac',
      body: 'Beacon will get Prometheus from OAra Labs (about {size}), put it in your Applications folder and start it. It keeps running when you log in, so your assistant is there whenever you open Beacon.',
      setUp: 'Set up Prometheus'
    },
    // A-inst: getting Prometheus, checking it, putting it in Applications, starting it and connecting (docs/ONBOARDING-v0.4.0.md §4, its
    // table of cards). {got} and {total} are sizes Beacon measured. What "Copy details" copies is main's, for someone helping: it may
    // use the technical words, and is not on the screen.
    aInst: {
      title: 'Setting up Prometheus',
      body: 'This takes about a minute. You can keep using your Mac.',
      steps: {
        get: 'Getting Prometheus…',
        getOf: 'Getting Prometheus… {got} MB of {total} MB',
        check: "Checking it's genuine",
        place: 'Putting it in your Applications folder',
        start: 'Starting it…',
        connect: 'Connecting to Prometheus…'
      },
      finePrint: "Your Mac will show a note that Prometheus was added to Login Items. That's expected: it keeps your assistant running when Beacon is closed.",
      stop: { title: 'Stop setting up?', body: 'Beacon will stop getting Prometheus and delete what it has downloaded so far.', keepGoing: 'Keep going', stop: 'Stop setting up' },
      download: { title: "We couldn't get Prometheus", body: 'Check your internet connection, then try again.' },
      oldMacos: { title: 'This Mac needs a newer version of macOS', body: 'Prometheus needs a newer macOS than this Mac has. Update macOS in System Settings, under General and then Software Update, and try again.' },
      unsafe: { title: "Prometheus didn't pass our safety check", body: "We didn't open it. This can happen on a bad connection." },
      place: { title: "We couldn't put Prometheus in your Applications folder", body: 'Check that you have room on this Mac, then try again.' },
      approval: { title: "Prometheus can't start at login yet", body: 'macOS is asking you to allow it. Open Login Items and turn Prometheus on.', openLoginItems: 'Open Login Items', notNow: 'Not now', watching: 'Beacon carries on by itself once it is on.' },
      notStarted: { title: "Prometheus didn't start", body: "Try once more. If it still doesn't start, we'll help." },
      inTheWay: { title: 'Something else is in the way', body: 'Another app on this Mac is using the spot Prometheus needs. Copy the details for whoever helps you.' },
      refused: { title: "Beacon couldn't connect to Prometheus", body: 'Try once more.' },
      tryAgain: 'Try again',
      getHelp: 'Get help',
      copyDetails: 'Copy details',
      copied: 'Copied'
    },
    // O9: how the assistant thinks (docs/ONBOARDING-v0.4.0-O9.md §2). {company} is Anthropic or OpenAI; {prefix} is how its keys start;
    // {memory} is what Beacon measured. Two facts from Prometheus #732 shape the cards: a valid Anthropic or OpenAI key on an account
    // with no credit is still "accepted" (only OpenRouter can be checked for credit), so the paste screen says the account needs it;
    // and a company that is busy (rate-limited) reads the same as one that cannot be reached, so those cards say both.
    a2: {
      title: 'How should your assistant think?',
      choicesLabel: 'How your assistant thinks',
      cloud: { title: 'With a cloud AI', detail: 'Ready in about a minute and usually smarter. Your messages go to the company you pick, and they charge for use.' },
      private: { title: 'Privately on this Mac', detail: 'Coming soon.' },
      memory: 'This Mac has {memory} of memory.'
    },
    a3c1: {
      title: 'Connect a cloud AI',
      openrouter: { title: 'Sign in with OpenRouter', detail: 'One account that gives your assistant Claude, ChatGPT, Gemini and more. No key to copy.' },
      credit: 'OpenRouter needs a few dollars of credit before your assistant can answer: $5 is the smallest amount, plus a small card fee.',
      addCredit: 'Add credit on OpenRouter',
      otherOptions: 'Other options',
      anthropic: 'Use a key from Anthropic (Claude)',
      openai: 'Use a key from OpenAI (ChatGPT)'
    },
    a3cOr: {
      title: 'Sign in with OpenRouter',
      body: "We'll open OpenRouter in your browser. Sign in, or create an account, then choose Authorize.",
      waiting: 'Waiting for you to finish in the browser…',
      checking: 'Checking your OpenRouter account…',
      noCredit: { title: 'Your OpenRouter account needs credit', body: 'Add a few dollars ($5 is the smallest amount), then try again.' },
      notFinished: { title: "The sign-in didn't finish", body: "Start it again when you're ready.", startAgain: 'Start again' },
      declined: { title: "OpenRouter wasn't connected", body: 'You chose not to connect it. Try again, or pick another option.' },
      refused: { title: "OpenRouter didn't accept the sign-in", body: 'Start it again. If it keeps happening, pick another option.' },
      unreachable: { title: "We couldn't reach OpenRouter", body: 'Check your internet connection. If OpenRouter is busy, wait a minute. Then try again.' }
    },
    a3c2: {
      title: 'Connect your {company} account',
      openKeys: "Open {company}'s key page",
      steps: ['Create a key named "Prometheus".', 'Copy it, then paste it here.'],
      fieldLabel: 'Your {company} key',
      show: 'Show',
      hide: 'Hide',
      // A good key is not proof of credit (Prometheus #732): say so before the first message finds out.
      finePrint: '{company} charges you for use, so your account needs credit or a payment method before your assistant can answer. Your key stays on this Mac.',
      check: 'Check key',
      checking: 'Checking…',
      shape: { title: "That doesn't look like a key from {company}", body: '{company} keys start with "{prefix}". Copy the whole key and paste it again.', pasteAgain: 'Paste again' },
      bad: { title: "{company} didn't accept this key", body: 'It may have been deleted, or copied only in part. Make a new key and paste it here.', open: 'Open {company}' },
      noCredit: { title: 'Your {company} account needs credit', body: '{company} needs credit or a payment method before your assistant can answer. Add one, then try again.', openBilling: 'Open {company} billing' },
      unreachable: { title: "We couldn't reach {company}", body: 'Check your internet connection. If {company} is busy, wait a minute. Then try again.' }
    },
    a5: {
      title: 'Finishing setup',
      steps: { save: 'Saving your choices', start: 'Starting your assistant', owner: 'Connecting this Mac as its owner' },
      notStarted: { title: "Prometheus didn't start", body: "Try once more. If it still doesn't start, we'll help." },
      trade: { title: "Beacon couldn't finish connecting", body: 'Try once more.' }
    },
    // F1: the first message (docs/ONBOARDING-v0.4.0.md §4). The first suggestion is the Recommended one.
    f1: {
      title: 'Say hello to your assistant',
      body: 'Try this, or type your own.',
      fieldLabel: 'Your message',
      chips: ['What can you help me with?', 'Plan a simple dinner for tonight', "Explain something I've always wondered about"],
      send: 'Send',
      thinking: 'Thinking…',
      slow: { title: 'No answer yet.', body: 'It may still be working.', keepWaiting: 'Keep waiting', tryAgain: 'Try again' },
      lost: { title: 'We lost touch with Prometheus.', body: "Check that it's turned on and on the same network, then reconnect.", reconnect: 'Reconnect' },
      refused: { title: "Prometheus couldn't take that message", body: "Try once more. If it still doesn't work, we'll help.", tryAgain: 'Try again', getHelp: 'Get help' },
      done: {
        title: "You're all set.",
        says: 'Your assistant says:',
        // How another computer joins: it asks, and an owner's Beacon approves it. Set up here, this Mac is that Beacon; connected to a
        // Prometheus elsewhere, the computer running it is.
        another: {
          here: 'To use another computer too, open Beacon there. This Mac will ask you to approve it.',
          there: 'To use another computer too, open Beacon there. Beacon on the computer running Prometheus will ask you to approve it.'
        },
        start: 'Start chatting',
        // An approved device only (path B): what an owner can do that it can't, and the way there, offered once.
        owner: {
          body: 'This Beacon can chat with your assistant. To also see and change everything on this Prometheus, make it an owner.',
          button: 'Make this Beacon an owner'
        }
      }
    },
    // B4: this Mac has asked a computer that already has an owner to let it connect, and waits for someone to say yes
    // (docs/ONBOARDING-v0.4.0.md §4, and the contract it follows: Prometheus docs/PAIRING-APPROVAL-API.md). {code} is the
    // four digits THIS Mac worked out; {time} is the minutes and seconds left. Telegram and the phone are not named: they are
    // opt-in on the other side, so by default approval happens in Beacon.
    b4: {
      title: 'Waiting for approval',
      asking: 'Asking {name}…',
      body: "We've asked {name} to let this Mac connect. Approve it in Beacon on a computer that already uses Prometheus.",
      asked: "We've asked {name} to let this Mac connect.",
      codeIntro: 'Make sure it shows this code:',
      asName: 'This Mac will appear as {device}.',
      waiting: 'Waiting for approval…',
      endsIn: 'Ends in {time}',
      ifNothing: 'If nothing happens, open Beacon on the computer running Prometheus. It will show this request.',
      // The computer says no one is connected to take the prompt (a Beacon of its owner's that is open would have): the way to get an answer is
      // to open Beacon on the computer running Prometheus.
      nobodyThere: 'No one is connected to approve this yet. Open Beacon on the computer running Prometheus; it will show this request.',
      // Prometheus on THIS Mac (installed some other way than this Beacon): there may be no other Beacon to say yes, so say it here.
      thisMac: 'Prometheus is running on this Mac, so you can say yes to this Mac yourself, right here.',
      showHow: 'Show me how'
    },
    bOk: {
      title: "You're connected",
      body: 'This Mac can now talk to {name}. It has its own list of conversations, and your assistant remembers what you tell it on any of your devices.',
      sayHello: 'Say hello'
    },
    // B-nojoin: the computer answered, but not with an offer to approve a new device (it is still being set up, has no
    // password, or is too old to say). The way on is the older setup.
    bNojoin: {
      title: "{name} can't approve this Mac",
      body: "It doesn't offer approval from another device. If it's already set up, open Beacon on the computer running Prometheus and approve this Mac there. Otherwise you can connect another way.",
      otherWay: 'Connect another way'
    },
    // What went wrong asking, or waiting. {name} is the computer; {wait} is "about 40 seconds".
    joinFailed: {
      actions: { askAgain: 'Ask again', tryAgain: 'Try again', otherWay: 'Connect another way' },
      wait: { seconds: 'about {n} seconds', minute: 'about a minute', minutes: 'about {n} minutes', soon: 'a little while' },
      denied: { title: 'The request was declined', body: 'Someone said no on another device. If that was a mistake, ask again.' },
      expired: { title: 'No one approved in time', body: 'A request only stays open for a few minutes. Open Beacon on the computer running Prometheus, then ask again.' },
      canceled: { title: 'The request was withdrawn', body: 'It was cancelled before anyone answered. You can ask again.' },
      gone: { title: 'The request was lost', body: '{name} no longer has it. Ask again.' },
      lost: { title: 'We lost touch with {name}', body: "Check that it's turned on and on the same network." },
      unavailable: { title: "{name} isn't accepting new devices", body: "It isn't set up to approve other devices right now. If it's already set up, open Beacon on the computer running Prometheus." },
      closed: { title: "{name} isn't accepting new devices right now", body: 'On the computer running Prometheus, open Beacon and choose Add a device. Then try again.' },
      'too-old': { title: '{name} needs an update', body: 'This version of Prometheus is too old to approve new devices.' },
      'busy-here': { title: 'A request from this Mac is already open', body: 'It closes by itself. Try again in {wait}.' },
      'busy-full': { title: '{name} is busy', body: 'Other devices are waiting for approval. Try again in {wait}.' },
      'too-many': { title: 'Too many requests', body: 'This Mac has asked too many times. Try again in {wait}.' },
      'slow-down': { title: 'Please wait a moment', body: 'Try again in a few seconds.' },
      identity: { title: "{name} isn't ready yet", body: 'Restart Prometheus on that computer, then try again.' },
      mismatch: {
        title: "The codes don't match",
        body: "{name} showed a different code from the one this Mac worked out, so something may be getting in between. Don't approve anything. Check that you're on your own network, then try again."
      },
      unreadable: { title: "{name} gave an answer Beacon didn't understand", body: 'Try again. If it keeps happening, update Beacon and Prometheus.' },
      refused: { title: "{name} couldn't take the request", body: "Try once more. If it still doesn't work, we'll help." },
      'not-same-computer': {
        title: "Something on your network isn't the Prometheus it says it is",
        body: "Beacon stopped before sending it anything. Check that you're on your own network, then try again."
      },
      'not-encrypted': {
        title: "{name} isn't offering an encrypted connection",
        body: 'Beacon only connects to computers on your home network over an encrypted connection. On {name}, update Prometheus and turn on home network, then try again.'
      },
      'not-encrypted-public': {
        title: "{name} isn't offering an encrypted connection",
        body: "It's outside your home network, and Beacon only connects to computers out there over an encrypted connection. Need help? at the top shows the secure ways to reach it."
      },
      'needs-newer-beacon': { title: 'This Beacon is too old for {name}', body: "It uses a more secure connection that this version of Beacon can't check yet. Update Beacon, then try again." },
      'not-saved': { title: "Approved, but this Mac couldn't keep the connection", body: "Beacon couldn't save it on this Mac. Ask again, and if it keeps happening, restart Beacon." },
      unopened: { title: 'Approved, but the answer was unreadable', body: 'Something went wrong while receiving it. Ask again.' }
    },
    bDiffers: {
      title: 'This looks different from last time',
      body: "{name} isn't the same computer this Mac connected to before. If you didn't reinstall Prometheus there, don't continue.",
      goBack: 'Go back',
      goOn: "It's fine, continue"
    }
  },
  advanced: {
    // Behind an "Advanced" link, for people who know the words: exempt from the banned-word lint.
    // B4, Prometheus on this Mac, behind "Show me how": Prometheus's own one line (`oara pair approve <id> --code <code>`), which a
    // person who installed Prometheus from the Terminal app can run there. Its words are Advanced's, like the line itself.
    approveHere: {
      intro: 'Open the Terminal app on this Mac and run this line. Beacon connects as soon as it has run.',
      copy: 'Copy',
      copied: 'Copied'
    },
    // The link on "We couldn't find Prometheus" that opens this screen (the owner, 2026-10-11: "or type its address"). It is the way
    // into Advanced, so it is held to Advanced's words, like the screen it opens.
    orType: 'Or type its address',
    // The same way in, offered on the question once a Prometheus has answered on this Mac (0.4.2). Advanced's words, like orType.
    w2Address: {
      title: 'Type its address',
      detail: "Connect to a computer by its name or address, if you know it."
    },
    bAdv: {
      title: 'Connect by address',
      body: "If you know the computer's name or address, type it here. A port you type is kept and shown.",
      placeholder: 'my-computer.local or 192.168.1.20',
      label: 'Computer name or address',
      find: 'Find it',
      finding: 'Asking…',
      invalid: "That doesn't look like a computer name or address.",
      unreachable: 'Nothing answered there. Check the name, the port, and that Prometheus is running.',
      notPrometheus: "Something answered, but it isn't a Prometheus.",
      notEncrypted: "Nothing answered there over an encrypted connection, and Beacon only connects to computers on your home network that way. If Prometheus is on that computer, update it and turn on home network, then try again.",
      notEncryptedPublic: "That computer is outside your home network and isn't offering an encrypted connection, so Beacon won't connect to it. Need help? at the top shows the secure ways to reach it.",
      where: 'at {address}'
    }
  },
  dev: {
    notBuilt: 'Not built yet',
    notBuiltDetail: 'This part of the new setup arrives in a later change. It is shown only in builds that are not released.',
    useOld: 'Use the old setup',
    skipToHello: 'Skip to the first message (dev)'
  }
} as const

/** Pour a computer's words into a template. A value is cleaned text, never markup; an unknown {name} stays
 *  as it is, so a typo shows up on screen instead of vanishing. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))
}

/** Every string under `main`, flattened (arrays included), for the copy lint. */
export function mainStrings(): string[] {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(COPY.main)
  return out
}
