package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
	"github.com/gray0128/agent-hub/internal/redact"
)

const (
	boardChannelMaxLen    = 64
	boardTitleMaxRunes    = 200
	boardTextMaxRunes     = 8192
	boardDataMaxBytes     = 32768
	boardOptionMaxItems   = 8
	boardOptionMaxRunes   = 200
	boardExpiresMinSec    = 600
	boardExpiresMaxSec    = 259200
	boardDefaultExpires   = 24 * time.Hour
	boardDefaultAskWait   = 30 * time.Minute
	boardDefaultWait      = 15 * time.Minute
	boardStdinMaxBytes    = 256 << 10
	boardHTTPTimeout       = 20 * time.Second
	boardFinalCheckBudget  = 5 * time.Second
	boardMessagesPageLimit = 200
	boardMessagesMaxPages  = 50
)

var (
	boardChannelRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*$`)
	actorProfileRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._@-]{0,39}$`)
	sourceNodeRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

	boardWSPingInterval   = 25 * time.Second
	boardWSPingTimeout    = 10 * time.Second
	boardWSReconnectDelay = 500 * time.Millisecond
)

func runBoard(g globalOpts, args []string) int {
	if len(args) == 0 {
		printBoardUsage()
		return failUsage(g.JSON, "usage: ahub board post|read|ask|wait ...")
	}
	switch args[0] {
	case "-h", "--help", "help":
		printBoardUsage()
		return api.ExitOK
	case "post":
		return runBoardPost(g, args[1:])
	case "read":
		return runBoardRead(g, args[1:])
	case "ask":
		return runBoardAsk(g, args[1:])
	case "wait":
		return runBoardWait(g, args[1:])
	default:
		printBoardUsage()
		return failUsage(g.JSON, fmt.Sprintf("unknown board subcommand %q (expected post|read|ask|wait)", args[0]))
	}
}

func printBoardUsage() {
	fmt.Fprintln(os.Stderr, `ahub board - cross-machine coordination board and blocking Q&A

Usage:
  ahub board post <channel> [--topic <tid> | --ref <ext_ref>] [--title <t>] [--kind note|handoff|artifact] [--status todo|in_progress|blocked|done|archived] [--data <json|@file|->] [--as <profile>] [--node <node_id>] [--idempotency-key <k>] [--json] <text | ->
  ahub board read [<channel>] [--topic <tid> | --ref <ext_ref>] [--status <s>] [--after <seq_or_cursor>] [--limit 50] [--json]
  ahub board ask <channel> [--topic <tid> | --ref <ext_ref>] [--title <t>] [--option <opt>]... [--expires 24h] [--wait 30m | --no-wait] [--data <json|@file|->] [--as <profile>] [--node <node_id>] [--idempotency-key <k>] [--json] <question_text | ->
  ahub board wait [<channel>] [--topic <tid> | --ref <ext_ref>] [--message <mid>] [--after <cursor>] [--timeout 15m] [--json]`)
}

func runBoardPost(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("board post", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var refFlag, topicID, titleFlag, kindFlag, statusFlag, dataFlag, asFlag, nodeFlag, idemKey string

	fs.StringVar(&refFlag, "ref", "", "external reference key for topic upsert")
	fs.StringVar(&topicID, "topic", "", "existing topic id")
	fs.StringVar(&titleFlag, "title", "", "topic title")
	fs.StringVar(&kindFlag, "kind", "note", "message kind: note|handoff|artifact")
	fs.StringVar(&statusFlag, "status", "", "topic status: todo|in_progress|blocked|done|archived")
	fs.StringVar(&dataFlag, "data", "", "structured JSON object, @file, or '-'")
	fs.StringVar(&asFlag, "as", "", "actor profile attribution")
	fs.StringVar(&nodeFlag, "node", "", "source node id attribution")
	fs.StringVar(&idemKey, "idempotency-key", "", "idempotency key (8..128 chars)")

	valFlags := boardValueFlags("--ref", "--topic", "--title", "--kind", "--status", "--data", "--as", "--node", "--idempotency-key")
	if err := parseFlagsFlexible(fs, args, valFlags); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return api.ExitOK
		}
		return api.ExitBadUsageOrInput
	}

	topicID = strings.TrimSpace(topicID)
	extRef := strings.TrimSpace(refFlag)
	if topicID != "" && extRef != "" {
		return failUsage(g.JSON, "--topic and --ref are mutually exclusive")
	}

	channel, textPos, err := parseBoardChannelAndTextPos(fs.Args(), topicID != "")
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}
	if channel != "" {
		channel, err = validateBoardChannel(channel)
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
	}

	kind := strings.TrimSpace(kindFlag)
	if !isValidBoardPostKind(kind) {
		return failUsage(g.JSON, fmt.Sprintf("unsupported --kind %q (expected note|handoff|artifact)", kind))
	}
	status := strings.TrimSpace(statusFlag)
	if status != "" && !isValidBoardTopicStatus(status) {
		return failUsage(g.JSON, fmt.Sprintf("unsupported --status %q (expected todo|in_progress|blocked|done|archived)", status))
	}

	actorProfile, err := resolveActorProfile(asFlag)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}
	sourceNode, err := validateSourceNode(nodeFlag)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}
	idemKey, err = validateIdempotencyKey(idemKey)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}

	if extRef != "" && utf8.RuneCountInString(extRef) > boardTitleMaxRunes {
		return failUsage(g.JSON, fmt.Sprintf("--ref exceeds %d characters", boardTitleMaxRunes))
	}

	redactedTitle := redact.Text(strings.TrimSpace(titleFlag))
	if utf8.RuneCountInString(redactedTitle) > boardTitleMaxRunes {
		return failUsage(g.JSON, fmt.Sprintf("--title exceeds %d characters", boardTitleMaxRunes))
	}

	redactedText, usedStdin, err := readBoardText(textPos)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}

	dataMap, err := parseBoardDataFlag(dataFlag, usedStdin)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}

	client, err := newBoardClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), boardHTTPTimeout)
	defer cancel()

	if topicID == "" {
		topicTitle := deriveBoardTopicTitle(redactedTitle, extRef, redactedText)
		topRes, err := client.CreateBoardTopic(ctx, api.CreateBoardTopicRequest{
			Channel:     channel,
			Title:       topicTitle,
			ExternalRef: extRef,
			Status:      status,
			Upsert:      extRef != "",
		})
		if err != nil {
			return failErr(g.JSON, err)
		}
		topicID = topRes.Topic.ID
	}

	msgRes, err := client.CreateBoardMessage(ctx, topicID, api.CreateBoardMessageRequest{
		Kind:           kind,
		TextMD:         redactedText,
		Data:           dataMap,
		ActorProfile:   actorProfile,
		SourceNode:     sourceNode,
		TopicStatus:    status,
		IdempotencyKey: idemKey,
	})
	if err != nil {
		return failErr(g.JSON, err)
	}

	redactBoardTopic(&msgRes.Topic)
	redactBoardMessage(&msgRes.Message)
	msgRes.Topic.LatestHandoff = nil

	if g.JSON {
		writeJSON(msgRes)
	} else {
		fmt.Printf("Posted %s (%s) to topic %s (%s) seq=%d cursor=%d\n",
			msgRes.Message.ID, msgRes.Message.Kind, msgRes.Topic.ID, msgRes.Topic.Channel, msgRes.Message.Seq, msgRes.Cursor)
	}
	return api.ExitOK
}

func runBoardRead(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("board read", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var refFlag, topicID, statusFlag string
	var afterVal int64
	var limit int

	fs.StringVar(&refFlag, "ref", "", "external reference key")
	fs.StringVar(&topicID, "topic", "", "topic id")
	fs.StringVar(&statusFlag, "status", "", "filter topics by status")
	fs.Int64Var(&afterVal, "after", 0, "after seq (with --topic/--ref) or after cursor (for events)")
	fs.IntVar(&limit, "limit", 50, "max items (1..200)")

	valFlags := boardValueFlags("--ref", "--topic", "--status", "--after", "--limit")
	if err := parseFlagsFlexible(fs, args, valFlags); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return api.ExitOK
		}
		return api.ExitBadUsageOrInput
	}

	afterSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "after" {
			afterSet = true
		}
	})

	topicID = strings.TrimSpace(topicID)
	extRef := strings.TrimSpace(refFlag)
	if topicID != "" && extRef != "" {
		return failUsage(g.JSON, "--topic and --ref are mutually exclusive")
	}

	pos := fs.Args()
	if len(pos) > 1 {
		return failUsage(g.JSON, "usage: ahub board read [<channel>] [--topic <tid> | --ref <ext_ref>] [--status <s>] [--after <seq_or_cursor>] [--limit 50] [--json]")
	}
	channel := ""
	if len(pos) == 1 {
		var err error
		channel, err = validateBoardChannel(pos[0])
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
	}

	status := strings.TrimSpace(statusFlag)
	if status != "" && !isValidBoardTopicStatus(status) {
		return failUsage(g.JSON, fmt.Sprintf("unsupported --status %q (expected todo|in_progress|blocked|done|archived)", status))
	}
	if afterVal < 0 {
		return failUsage(g.JSON, "--after must be >= 0")
	}
	if limit < 1 || limit > 200 {
		return failUsage(g.JSON, "--limit must be between 1 and 200")
	}

	client, err := newBoardClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), boardHTTPTimeout)
	defer cancel()

	// Mode 1: topic or ref -> topic timeline + messages (preserves latest_handoff)
	if topicID != "" || extRef != "" {
		if topicID == "" {
			resolved, code := resolveTopicByRef(ctx, g.JSON, client, channel, extRef)
			if code != api.ExitOK {
				return code
			}
			topicID = resolved.ID
		}
		msgsRes, err := client.GetBoardTopicMessages(ctx, topicID, afterVal, limit)
		if err != nil {
			return failErr(g.JSON, err)
		}
		if channel != "" && msgsRes.Topic.Channel != channel {
			return failUsage(g.JSON, fmt.Sprintf("topic %s belongs to channel %q, not %q", topicID, msgsRes.Topic.Channel, channel))
		}
		redactBoardTopic(&msgsRes.Topic)
		for i := range msgsRes.Messages {
			redactBoardMessage(&msgsRes.Messages[i])
		}
		if g.JSON {
			writeJSON(msgsRes)
		} else {
			fmt.Printf("Topic %s [%s] %s (%s) cursor=%d\n",
				msgsRes.Topic.ID, msgsRes.Topic.Status, msgsRes.Topic.Title, msgsRes.Topic.Channel, msgsRes.Cursor)
			for _, m := range msgsRes.Messages {
				actor := firstNonEmpty(m.ActorProfile, m.ActorScope)
				snippet := boundRunes(strings.ReplaceAll(m.TextMD, "\n", " "), 100)
				fmt.Printf("#%d  %-9s %-16s %-10s %s\n", m.Seq, m.Kind, actor, m.SourceNode, snippet)
			}
		}
		return api.ExitOK
	}

	// Mode 2: --after explicitly set -> incremental events stream
	if afterSet {
		evRes, err := client.ListBoardEvents(ctx, api.ListBoardEventsOptions{
			Channel:     channel,
			AfterCursor: afterVal,
			Limit:       limit,
		})
		if err != nil {
			return failErr(g.JSON, err)
		}
		if g.JSON {
			writeJSON(evRes)
		} else if len(evRes.Events) == 0 {
			fmt.Printf("No board events (next_cursor=%d)\n", evRes.NextCursor)
		} else {
			for _, ev := range evRes.Events {
				msgID := "-"
				if ev.MessageID != nil {
					msgID = *ev.MessageID
				}
				fmt.Printf("cursor=%-4d %-18s %-14s %-12s %s\n",
					ev.Cursor, ev.EventType, ev.Channel, ev.TopicID, msgID)
			}
		}
		return api.ExitOK
	}

	// Mode 3: channel or status filter -> topics list (preserves latest_handoff)
	if channel != "" || status != "" {
		topRes, err := client.ListBoardTopics(ctx, api.ListBoardTopicsOptions{
			Channel: channel,
			Status:  status,
			Limit:   limit,
		})
		if err != nil {
			return failErr(g.JSON, err)
		}
		for i := range topRes.Topics {
			redactBoardTopic(&topRes.Topics[i])
		}
		if g.JSON {
			writeJSON(topRes)
		} else if len(topRes.Topics) == 0 {
			fmt.Println("No board topics found")
		} else {
			for _, top := range topRes.Topics {
				fmt.Printf("%s  %-11s %-16s cursor=%-4d %s\n",
					top.ID, top.Status, top.Channel, top.LastEventCursor, boundRunes(top.Title, 80))
			}
		}
		return api.ExitOK
	}

	// Mode 4: bare `ahub board read` -> channel summary list
	chRes, err := client.ListBoardChannels(ctx)
	if err != nil {
		return failErr(g.JSON, err)
	}
	if g.JSON {
		writeJSON(chRes)
	} else if len(chRes.Channels) == 0 {
		fmt.Println("No board channels found")
	} else {
		for _, ch := range chRes.Channels {
			fmt.Printf("%-24s active=%-4d open_questions=%d\n", ch.Channel, ch.ActiveTopicCount, ch.OpenQuestionCount)
		}
	}
	return api.ExitOK
}

func runBoardAsk(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("board ask", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var refFlag, topicID, titleFlag, dataFlag, asFlag, nodeFlag, idemKey string
	var options stringSliceFlag
	var expiresDur, waitDur time.Duration
	var noWait bool

	fs.StringVar(&refFlag, "ref", "", "external reference key for topic upsert")
	fs.StringVar(&topicID, "topic", "", "existing topic id")
	fs.StringVar(&titleFlag, "title", "", "topic title")
	fs.Var(&options, "option", "candidate answer option (repeatable, max 8)")
	fs.DurationVar(&expiresDur, "expires", boardDefaultExpires, "question expiry duration (10m..72h)")
	fs.DurationVar(&waitDur, "wait", boardDefaultAskWait, "wait duration for answer")
	fs.BoolVar(&noWait, "no-wait", false, "do not wait for answer after posting")
	fs.StringVar(&dataFlag, "data", "", "structured JSON object, @file, or '-'")
	fs.StringVar(&asFlag, "as", "", "actor profile attribution")
	fs.StringVar(&nodeFlag, "node", "", "source node id attribution")
	fs.StringVar(&idemKey, "idempotency-key", "", "idempotency key (8..128 chars)")

	valFlags := boardValueFlags("--ref", "--topic", "--title", "--option", "--expires", "--wait", "--data", "--as", "--node", "--idempotency-key")
	if err := parseFlagsFlexible(fs, args, valFlags); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return api.ExitOK
		}
		return api.ExitBadUsageOrInput
	}

	waitExplicit := false
	noWaitExplicit := false
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "wait":
			waitExplicit = true
		case "no-wait":
			noWaitExplicit = true
		}
	})
	if waitExplicit && noWaitExplicit && noWait {
		return failUsage(g.JSON, "--wait and --no-wait are mutually exclusive")
	}

	topicID = strings.TrimSpace(topicID)
	extRef := strings.TrimSpace(refFlag)
	if topicID != "" && extRef != "" {
		return failUsage(g.JSON, "--topic and --ref are mutually exclusive")
	}

	channel, textPos, err := parseBoardChannelAndTextPos(fs.Args(), topicID != "")
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}
	if channel != "" {
		channel, err = validateBoardChannel(channel)
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
	}

	actorProfile, err := resolveActorProfile(asFlag)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}
	sourceNode, err := validateSourceNode(nodeFlag)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}
	idemKey, err = validateIdempotencyKey(idemKey)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}

	if len(options) > boardOptionMaxItems {
		return failUsage(g.JSON, fmt.Sprintf("at most %d --option values are allowed", boardOptionMaxItems))
	}
	redactedOptions := make([]string, 0, len(options))
	for _, opt := range options {
		cleaned := strings.TrimSpace(redact.Text(opt))
		rc := utf8.RuneCountInString(cleaned)
		if rc == 0 || rc > boardOptionMaxRunes {
			return failUsage(g.JSON, fmt.Sprintf("each --option must be 1..%d characters", boardOptionMaxRunes))
		}
		redactedOptions = append(redactedOptions, cleaned)
	}

	expiresSec := int(expiresDur.Seconds())
	if expiresSec < boardExpiresMinSec || expiresSec > boardExpiresMaxSec {
		return failUsage(g.JSON, fmt.Sprintf("--expires must be between %ds (10m) and %ds (72h)", boardExpiresMinSec, boardExpiresMaxSec))
	}
	if !noWait && waitDur < 0 {
		return failUsage(g.JSON, "--wait must be >= 0")
	}

	if extRef != "" && utf8.RuneCountInString(extRef) > boardTitleMaxRunes {
		return failUsage(g.JSON, fmt.Sprintf("--ref exceeds %d characters", boardTitleMaxRunes))
	}
	redactedTitle := redact.Text(strings.TrimSpace(titleFlag))
	if utf8.RuneCountInString(redactedTitle) > boardTitleMaxRunes {
		return failUsage(g.JSON, fmt.Sprintf("--title exceeds %d characters", boardTitleMaxRunes))
	}

	redactedText, usedStdin, err := readBoardText(textPos)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}
	dataMap, err := parseBoardDataFlag(dataFlag, usedStdin)
	if err != nil {
		return failUsage(g.JSON, err.Error())
	}

	client, err := newBoardClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), boardHTTPTimeout)
	defer cancel()

	if topicID == "" {
		topicTitle := deriveBoardTopicTitle(redactedTitle, extRef, redactedText)
		topRes, err := client.CreateBoardTopic(ctx, api.CreateBoardTopicRequest{
			Channel:     channel,
			Title:       topicTitle,
			ExternalRef: extRef,
			Upsert:      extRef != "",
		})
		if err != nil {
			return failErr(g.JSON, err)
		}
		topicID = topRes.Topic.ID
		if channel == "" {
			channel = topRes.Topic.Channel
		}
	}

	postRes, err := client.CreateBoardMessage(ctx, topicID, api.CreateBoardMessageRequest{
		Kind:               "question",
		TextMD:             redactedText,
		Data:               dataMap,
		ActorProfile:       actorProfile,
		SourceNode:         sourceNode,
		QuestionOptions:    redactedOptions,
		QuestionExpiresSec: expiresSec,
		IdempotencyKey:     idemKey,
	})
	if err != nil {
		return failErr(g.JSON, err)
	}
	if channel == "" {
		channel = postRes.Topic.Channel
	}

	redactBoardTopic(&postRes.Topic)
	redactBoardMessage(&postRes.Message)

	if noWait || waitDur == 0 {
		postRes.Topic.LatestHandoff = nil
		if g.JSON {
			writeJSON(postRes)
		} else {
			fmt.Printf("Asked %s on topic %s (%s) state=%s cursor=%d\n",
				postRes.Message.ID, postRes.Topic.ID, postRes.Topic.Channel, postRes.Message.QuestionState, postRes.Cursor)
		}
		return api.ExitOK
	}

	return waitBoardQuestion(g.JSON, client, postRes.Topic.ID, channel, postRes.Message.ID, postRes.Cursor, &postRes.Topic, waitDur)
}

func runBoardWait(g globalOpts, args []string) int {
	fs := flag.NewFlagSet("board wait", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var topicID, refFlag, messageID string
	var afterCursor int64
	var timeoutDur time.Duration

	fs.StringVar(&topicID, "topic", "", "topic id")
	fs.StringVar(&refFlag, "ref", "", "external reference key")
	fs.StringVar(&messageID, "message", "", "question message id")
	fs.Int64Var(&afterCursor, "after", 0, "resume WS replay after this board event cursor")
	fs.DurationVar(&timeoutDur, "timeout", boardDefaultWait, "wait timeout")

	valFlags := boardValueFlags("--topic", "--ref", "--message", "--after", "--timeout")
	if err := parseFlagsFlexible(fs, args, valFlags); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return api.ExitOK
		}
		return api.ExitBadUsageOrInput
	}

	afterSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "after" {
			afterSet = true
		}
	})

	topicID = strings.TrimSpace(topicID)
	extRef := strings.TrimSpace(refFlag)
	messageID = strings.TrimSpace(messageID)
	if topicID != "" && extRef != "" {
		return failUsage(g.JSON, "--topic and --ref are mutually exclusive")
	}
	if topicID == "" && extRef == "" {
		return failUsage(g.JSON, "--topic or --ref is required")
	}
	if afterCursor < 0 {
		return failUsage(g.JSON, "--after must be >= 0")
	}
	if timeoutDur <= 0 {
		return failUsage(g.JSON, "--timeout must be > 0")
	}

	pos := fs.Args()
	if len(pos) > 1 {
		return failUsage(g.JSON, "usage: ahub board wait [<channel>] [--topic <tid> | --ref <ext_ref>] [--message <mid>] [--after <cursor>] [--timeout 15m] [--json]")
	}
	channel := ""
	if len(pos) == 1 {
		var err error
		channel, err = validateBoardChannel(pos[0])
		if err != nil {
			return failUsage(g.JSON, err.Error())
		}
	}

	client, err := newBoardClient(g)
	if err != nil {
		return failErr(g.JSON, err)
	}

	var initialTopic *api.BoardTopic
	if topicID == "" {
		ctx, cancel := context.WithTimeout(context.Background(), boardHTTPTimeout)
		resolved, code := resolveTopicByRef(ctx, g.JSON, client, channel, extRef)
		cancel()
		if code != api.ExitOK {
			return code
		}
		topicID = resolved.ID
		initialTopic = resolved
		if channel == "" {
			channel = resolved.Channel
		}
	}

	if !afterSet {
		ctx, cancel := context.WithTimeout(context.Background(), boardHTTPTimeout)
		msgsRes, err := fetchAllBoardTopicMessages(ctx, client, topicID)
		cancel()
		if err != nil {
			return failErr(g.JSON, err)
		}
		if channel != "" && msgsRes.Topic.Channel != channel {
			return failUsage(g.JSON, fmt.Sprintf("topic %s belongs to channel %q, not %q", topicID, msgsRes.Topic.Channel, channel))
		}
		initialTopic = &msgsRes.Topic
		if channel == "" {
			channel = msgsRes.Topic.Channel
		}
		if ans := findAnsweredQuestionResponse(msgsRes, messageID); ans != nil {
			return outputBoardAnswer(g.JSON, ans)
		}
		if err := checkClosedUnansweredQuestion(msgsRes, messageID); err != nil {
			return failErr(g.JSON, err)
		}
		if messageID == "" {
			messageID = findLatestOpenQuestionID(msgsRes.Messages)
		}
		afterCursor = msgsRes.Cursor
	}

	return waitBoardQuestion(g.JSON, client, topicID, channel, messageID, afterCursor, initialTopic, timeoutDur)
}

func waitBoardQuestion(
	asJSON bool,
	client *api.Client,
	topicID string,
	channel string,
	targetMsgID string,
	startCursor int64,
	initialTopic *api.BoardTopic,
	timeout time.Duration,
) int {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	highestCursor := startCursor
	latestTopic := initialTopic
	seenQuestionID := targetMsgID
	var lastErr error

	for {
		if ctx.Err() != nil {
			break
		}
		q := url.Values{}
		q.Set("topic_id", topicID)
		q.Set("after_cursor", strconv.FormatInt(highestCursor, 10))
		wsPath := "/ws/stream?" + q.Encode()

		conn, err := client.DialWebSocket(ctx, wsPath)
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				break
			}
			if isFatalWaitAPIError(err) {
				return failErr(asJSON, err)
			}
			fmt.Fprintf(os.Stderr, "[ahub board] ws dial failed (%v); checking http and retrying...\n", err)

			if msgsRes, httpErr := fetchBoardMessagesBounded(ctx, client, topicID); httpErr == nil {
				latestTopic = &msgsRes.Topic
				if channel == "" {
					channel = msgsRes.Topic.Channel
				}
				if ans := findAnsweredQuestionResponse(msgsRes, targetMsgID); ans != nil {
					return outputBoardAnswer(asJSON, ans)
				}
				if stateErr := checkClosedUnansweredQuestion(msgsRes, targetMsgID); stateErr != nil {
					return failErr(asJSON, stateErr)
				}
				if targetMsgID == "" {
					if latestOpen := findLatestOpenQuestionID(msgsRes.Messages); latestOpen != "" {
						seenQuestionID = latestOpen
					}
				}
			} else if isFatalWaitAPIError(httpErr) {
				return failErr(asJSON, httpErr)
			}

			select {
			case <-ctx.Done():
				goto timedOut
			case <-time.After(boardWSReconnectDelay):
				continue
			}
		}

		lastErr = nil
		ansRes, fatalErr, connErr := readBoardWSConnection(ctx, client, conn, topicID, targetMsgID, &highestCursor, &latestTopic, &channel, &seenQuestionID)
		if fatalErr != nil {
			return failErr(asJSON, fatalErr)
		}
		if ansRes != nil {
			return outputBoardAnswer(asJSON, ansRes)
		}
		lastErr = connErr
		if ctx.Err() != nil {
			break
		}
		fmt.Fprintf(os.Stderr, "[ahub board] ws disconnected (%v); reconnecting after cursor %d...\n", lastErr, highestCursor)
		select {
		case <-ctx.Done():
			goto timedOut
		case <-time.After(boardWSReconnectDelay):
		}
	}

timedOut:
	if msgsRes, err := fetchBoardMessagesBounded(context.Background(), client, topicID); err == nil {
		latestTopic = &msgsRes.Topic
		if channel == "" {
			channel = msgsRes.Topic.Channel
		}
		if ans := findAnsweredQuestionResponse(msgsRes, targetMsgID); ans != nil {
			return outputBoardAnswer(asJSON, ans)
		}
		if stateErr := checkClosedUnansweredQuestion(msgsRes, targetMsgID); stateErr != nil {
			return failErr(asJSON, stateErr)
		}
		if targetMsgID == "" {
			if latestOpen := findLatestOpenQuestionID(msgsRes.Messages); latestOpen != "" {
				seenQuestionID = latestOpen
			}
		}
		if msgsRes.Cursor > highestCursor {
			highestCursor = msgsRes.Cursor
		}
	} else if isFatalWaitAPIError(err) {
		return failErr(asJSON, err)
	}

	if latestTopic != nil {
		redactBoardTopic(latestTopic)
		latestTopic.LatestHandoff = nil
	}

	nextCmd := fmt.Sprintf("ahub board wait --topic %s --after %d --json", topicID, highestCursor)
	if channel != "" {
		nextCmd = fmt.Sprintf("ahub board wait %s --topic %s --after %d --json", channel, topicID, highestCursor)
	}

	if asJSON {
		writeJSON(api.BoardWaitTimeoutResult{
			OK:            false,
			TimedOut:      true,
			Channel:       channel,
			TopicID:       topicID,
			MessageID:     seenQuestionID,
			Cursor:        highestCursor,
			QuestionState: "open",
			Topic:         latestTopic,
			Next:          []string{nextCmd},
		})
	} else {
		fmt.Fprintf(os.Stderr, "Timed out waiting for answer on topic %s (message=%s question_state=open cursor=%d)\nNext: %s\n",
			topicID, firstNonEmpty(seenQuestionID, "-"), highestCursor, nextCmd)
	}
	return api.ExitWaitTimeout
}

func fetchBoardMessagesBounded(parent context.Context, client *api.Client, topicID string) (*api.BoardMessagesResponse, error) {
	ctx, cancel := context.WithTimeout(parent, boardFinalCheckBudget)
	defer cancel()
	return fetchAllBoardTopicMessages(ctx, client, topicID)
}

func fetchAllBoardTopicMessages(ctx context.Context, client *api.Client, topicID string) (*api.BoardMessagesResponse, error) {
	var combined *api.BoardMessagesResponse
	var afterSeq int64
	for pageIdx := 0; pageIdx < boardMessagesMaxPages; pageIdx++ {
		page, err := client.GetBoardTopicMessages(ctx, topicID, afterSeq, boardMessagesPageLimit)
		if err != nil {
			return nil, err
		}
		if combined == nil {
			combined = page
		} else {
			combined.Topic = page.Topic
			if page.Cursor > combined.Cursor {
				combined.Cursor = page.Cursor
			}
			combined.Messages = append(combined.Messages, page.Messages...)
		}
		if len(page.Messages) < boardMessagesPageLimit {
			break
		}
		nextAfter := int64(page.Messages[len(page.Messages)-1].Seq)
		if nextAfter <= afterSeq {
			break
		}
		afterSeq = nextAfter
	}
	return combined, nil
}

func readBoardWSConnection(
	ctx context.Context,
	client *api.Client,
	conn *websocket.Conn,
	topicID string,
	targetMsgID string,
	highestCursor *int64,
	latestTopic **api.BoardTopic,
	channel *string,
	seenQuestionID *string,
) (*api.AnswerBoardQuestionResponse, error, error) {
	pingCtx, pingCancel := context.WithCancel(ctx)
	defer pingCancel()
	defer func() { _ = conn.CloseNow() }()

	go func() {
		ticker := time.NewTicker(boardWSPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-ticker.C:
				pCtx, pCancel := context.WithTimeout(pingCtx, boardWSPingTimeout)
				pingErr := conn.Ping(pCtx)
				pCancel()
				if pingErr != nil {
					_ = conn.CloseNow()
					return
				}
			}
		}
	}()

	for {
		_, data, readErr := conn.Read(ctx)
		if readErr != nil {
			return nil, nil, readErr
		}

		var frame struct {
			Type     string            `json:"type"`
			Code     string            `json:"code"`
			Message  json.RawMessage   `json:"message"`
			Topic    *api.BoardTopic   `json:"topic"`
			Question *api.BoardMessage `json:"question"`
			Answer   *api.BoardMessage `json:"answer"`
			Cursor   int64             `json:"cursor"`
		}
		if json.Unmarshal(data, &frame) != nil {
			continue
		}

		switch frame.Type {
		case "error":
			var errMsg string
			_ = json.Unmarshal(frame.Message, &errMsg)
			httpStatus := 400
			if frame.Code == "FORBIDDEN_SCOPE" || frame.Code == "UNAUTHORIZED" {
				httpStatus = 403
			} else if frame.Code == "NOT_FOUND" {
				httpStatus = 404
			}
			return nil, &api.APIError{
				HTTPStatus: httpStatus,
				Body: api.ErrorBody{
					Code:    firstNonEmpty(frame.Code, "WS_ERROR"),
					Message: firstNonEmpty(errMsg, "WebSocket stream rejected"),
				},
			}, nil

		case "snapshot":
			// Intentionally do NOT advance highestCursor from snapshot.Topic.LastEventCursor
			// so any reconnect replays missed board.* events since the last received event frame.
			if frame.Topic != nil && frame.Topic.ID == topicID {
				*latestTopic = frame.Topic
				if *channel == "" {
					*channel = frame.Topic.Channel
				}
				if topicHasZeroOpenQuestions(frame.Topic) && client != nil {
					if msgsRes, httpErr := fetchBoardMessagesBounded(ctx, client, topicID); httpErr == nil {
						*latestTopic = &msgsRes.Topic
						if *channel == "" {
							*channel = msgsRes.Topic.Channel
						}
						if ans := findAnsweredQuestionResponse(msgsRes, targetMsgID); ans != nil {
							return ans, nil, nil
						}
						if stateErr := checkClosedUnansweredQuestion(msgsRes, targetMsgID); stateErr != nil {
							return nil, stateErr, nil
						}
					}
				}
			}

		case "board.topic_updated":
			if frame.Topic != nil && frame.Topic.ID == topicID {
				*latestTopic = frame.Topic
				if *channel == "" {
					*channel = frame.Topic.Channel
				}
				if frame.Cursor > *highestCursor {
					*highestCursor = frame.Cursor
				}
				if topicHasZeroOpenQuestions(frame.Topic) {
					if client != nil {
						if msgsRes, httpErr := fetchBoardMessagesBounded(ctx, client, topicID); httpErr == nil {
							*latestTopic = &msgsRes.Topic
							if ans := findAnsweredQuestionResponse(msgsRes, targetMsgID); ans != nil {
								return ans, nil, nil
							}
							if stateErr := checkClosedUnansweredQuestion(msgsRes, targetMsgID); stateErr != nil {
								return nil, stateErr, nil
							}
						} else if targetMsgID != "" || *seenQuestionID != "" {
							return nil, &api.APIError{
								HTTPStatus: 409,
								Body: api.ErrorBody{
									Code:    "INVALID_STATE_TRANSITION",
									Message: fmt.Sprintf("question %s is no longer open", firstNonEmpty(targetMsgID, *seenQuestionID)),
								},
							}, nil
						}
					} else if targetMsgID != "" || *seenQuestionID != "" {
						return nil, &api.APIError{
							HTTPStatus: 409,
							Body: api.ErrorBody{
								Code:    "INVALID_STATE_TRANSITION",
								Message: fmt.Sprintf("question %s is no longer open", firstNonEmpty(targetMsgID, *seenQuestionID)),
							},
						}, nil
					}
				}
			}

		case "board.message_created":
			var msg api.BoardMessage
			if len(frame.Message) > 0 && json.Unmarshal(frame.Message, &msg) == nil && msg.TopicID == topicID {
				if frame.Cursor > *highestCursor {
					*highestCursor = frame.Cursor
				}
				if frame.Topic != nil && frame.Topic.ID == topicID {
					*latestTopic = frame.Topic
				}
				if *channel == "" {
					*channel = msg.Channel
				}
				if msg.Kind == "question" {
					if msg.QuestionState == "open" {
						if targetMsgID == "" {
							*seenQuestionID = msg.ID
						}
					} else if msg.QuestionState == "expired" || msg.QuestionState == "cancelled" || msg.QuestionState == "answered" {
						if targetMsgID == "" && *seenQuestionID == msg.ID {
							*seenQuestionID = ""
						}
					}
				}
				if msg.Kind == "question" && (msg.QuestionState == "expired" || msg.QuestionState == "cancelled") {
					closedErr := func() error {
						return &api.APIError{
							HTTPStatus: 409,
							Body: api.ErrorBody{
								Code:    "INVALID_STATE_TRANSITION",
								Message: fmt.Sprintf("question %s is already %s", msg.ID, msg.QuestionState),
							},
						}
					}
					if targetMsgID != "" {
						if msg.ID == targetMsgID {
							return nil, closedErr(), nil
						}
					} else if frame.Topic != nil && frame.Topic.OpenQuestionCount != nil {
						if *frame.Topic.OpenQuestionCount == 0 {
							return nil, closedErr(), nil
						}
					} else if client != nil {
						if msgsRes, httpErr := fetchBoardMessagesBounded(ctx, client, topicID); httpErr == nil {
							*latestTopic = &msgsRes.Topic
							if *channel == "" {
								*channel = msgsRes.Topic.Channel
							}
							if ans := findAnsweredQuestionResponse(msgsRes, targetMsgID); ans != nil {
								return ans, nil, nil
							}
							if stateErr := checkClosedUnansweredQuestion(msgsRes, targetMsgID); stateErr != nil {
								return nil, stateErr, nil
							}
							if latestOpen := findLatestOpenQuestionID(msgsRes.Messages); latestOpen != "" {
								*seenQuestionID = latestOpen
							}
						} else if ctx.Err() != nil {
							return nil, nil, ctx.Err()
						} else {
							return nil, closedErr(), nil
						}
					} else {
						return nil, closedErr(), nil
					}
				}
			}

		case "board.question_answered":
			if frame.Cursor > *highestCursor {
				*highestCursor = frame.Cursor
			}
			if frame.Question != nil && frame.Answer != nil {
				matchesTopic := frame.Question.TopicID == topicID || (frame.Topic != nil && frame.Topic.ID == topicID)
				matchesMsg := targetMsgID == "" || frame.Question.ID == targetMsgID
				if matchesTopic && matchesMsg {
					var topicOut api.BoardTopic
					if frame.Topic != nil {
						topicOut = *frame.Topic
					} else if *latestTopic != nil {
						topicOut = **latestTopic
					}
					return &api.AnswerBoardQuestionResponse{
						OK:       true,
						Topic:    topicOut,
						Question: *frame.Question,
						Answer:   *frame.Answer,
						Cursor:   frame.Cursor,
					}, nil, nil
				}
			}
		}
	}
}

func outputBoardAnswer(asJSON bool, res *api.AnswerBoardQuestionResponse) int {
	redactBoardTopic(&res.Topic)
	redactBoardMessage(&res.Question)
	redactBoardMessage(&res.Answer)
	res.Topic.LatestHandoff = nil
	if asJSON {
		writeJSON(res)
	} else {
		actor := firstNonEmpty(res.Answer.ActorProfile, res.Answer.ActorScope)
		fmt.Printf("Answered %s by %s on topic %s (%s) cursor=%d\n%s\n",
			res.Question.ID, actor, res.Topic.ID, res.Topic.Channel, res.Cursor, res.Answer.TextMD)
	}
	return api.ExitOK
}

func findAnsweredQuestionResponse(msgsRes *api.BoardMessagesResponse, targetMsgID string) *api.AnswerBoardQuestionResponse {
	if msgsRes == nil {
		return nil
	}
	byID := make(map[string]api.BoardMessage, len(msgsRes.Messages))
	for _, m := range msgsRes.Messages {
		byID[m.ID] = m
	}
	for i := len(msgsRes.Messages) - 1; i >= 0; i-- {
		q := msgsRes.Messages[i]
		if q.Kind != "question" {
			continue
		}
		if targetMsgID != "" && q.ID != targetMsgID {
			continue
		}
		if q.QuestionState == "answered" && q.AnsweredMessageID != nil {
			if ans, ok := byID[*q.AnsweredMessageID]; ok {
				return &api.AnswerBoardQuestionResponse{
					OK:       true,
					Topic:    msgsRes.Topic,
					Question: q,
					Answer:   ans,
					Cursor:   msgsRes.Cursor,
				}
			}
		}
		if targetMsgID == "" {
			break
		}
	}
	return nil
}

func checkClosedUnansweredQuestion(msgsRes *api.BoardMessagesResponse, targetMsgID string) error {
	if msgsRes == nil {
		return nil
	}
	if targetMsgID != "" {
		for _, m := range msgsRes.Messages {
			if m.ID == targetMsgID && m.Kind == "question" && (m.QuestionState == "expired" || m.QuestionState == "cancelled") {
				return &api.APIError{
					HTTPStatus: 409,
					Body: api.ErrorBody{
						Code:    "INVALID_STATE_TRANSITION",
						Message: fmt.Sprintf("question %s is already %s", m.ID, m.QuestionState),
					},
				}
			}
		}
		return nil
	}
	if findLatestOpenQuestionID(msgsRes.Messages) != "" {
		return nil
	}
	for i := len(msgsRes.Messages) - 1; i >= 0; i-- {
		m := msgsRes.Messages[i]
		if m.Kind != "question" {
			continue
		}
		if m.QuestionState == "expired" || m.QuestionState == "cancelled" {
			return &api.APIError{
				HTTPStatus: 409,
				Body: api.ErrorBody{
					Code:    "INVALID_STATE_TRANSITION",
					Message: fmt.Sprintf("question %s is already %s", m.ID, m.QuestionState),
				},
			}
		}
		break
	}
	return nil
}

func topicHasZeroOpenQuestions(topic *api.BoardTopic) bool {
	return topic != nil && topic.OpenQuestionCount != nil && *topic.OpenQuestionCount == 0
}

func findLatestOpenQuestionID(messages []api.BoardMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if m.Kind == "question" && m.QuestionState == "open" {
			return m.ID
		}
	}
	return ""
}

func resolveTopicByRef(ctx context.Context, asJSON bool, client *api.Client, channel, extRef string) (*api.BoardTopic, int) {
	res, err := client.ListBoardTopics(ctx, api.ListBoardTopicsOptions{
		Channel:     channel,
		ExternalRef: extRef,
		Limit:       10,
	})
	if err != nil {
		return nil, failErr(asJSON, err)
	}
	if len(res.Topics) == 0 {
		return nil, failErr(asJSON, &api.APIError{
			HTTPStatus: 404,
			Body: api.ErrorBody{
				Code:    "NOT_FOUND",
				Message: fmt.Sprintf("no board topic found matching ref %q", extRef),
			},
		})
	}
	if len(res.Topics) > 1 {
		candidates := make([]string, 0, len(res.Topics))
		for _, top := range res.Topics {
			candidates = append(candidates, fmt.Sprintf("%s (%s)", top.Channel, top.ID))
		}
		return nil, failUsage(asJSON, fmt.Sprintf("multiple topics matched ref %q: %s (specify <channel> or --topic)", extRef, strings.Join(candidates, ", ")))
	}
	return &res.Topics[0], api.ExitOK
}

func newBoardClient(g globalOpts) (*api.Client, error) {
	hubURL, token, err := config.ResolveCredentials(g.URL, g.Token)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(token) == "" {
		return nil, &api.APIError{
			HTTPStatus: 401,
			Body: api.ErrorBody{
				Code:    "UNAUTHORIZED",
				Message: "missing caller authentication token (set AHUB_TOKEN, --token, or run ahub auth login; node.json is never used by ahub board)",
				Next:    []string{"ahub auth status --verify --json"},
			},
		}
	}
	return api.NewClient(hubURL, token), nil
}

func boardValueFlags(longFlags ...string) map[string]bool {
	m := make(map[string]bool, len(longFlags)*2)
	for _, lf := range longFlags {
		m[lf] = true
		if strings.HasPrefix(lf, "--") {
			m[lf[1:]] = true
		}
	}
	return m
}

func parseBoardChannelAndTextPos(pos []string, allowChannelOmitted bool) (string, []string, error) {
	if allowChannelOmitted {
		if len(pos) == 0 {
			return "", nil, errors.New("message text or '-' (stdin) is required")
		}
		if len(pos) == 1 {
			return "", pos, nil
		}
		return pos[0], pos[1:], nil
	}
	if len(pos) < 2 {
		return "", nil, errors.New("<channel> and <text | -> are required")
	}
	return pos[0], pos[1:], nil
}

func validateBoardChannel(raw string) (string, error) {
	ch := strings.TrimSpace(raw)
	if ch == "" || len(ch) > boardChannelMaxLen || !boardChannelRe.MatchString(ch) {
		return "", fmt.Errorf("invalid channel %q (must match ^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*$ and <= %d chars)", ch, boardChannelMaxLen)
	}
	return ch, nil
}

func resolveActorProfile(flagVal string) (string, error) {
	profile := strings.TrimSpace(flagVal)
	if profile == "" {
		profile = strings.TrimSpace(os.Getenv("AHUB_PROFILE"))
	}
	if profile == "" {
		return "", nil
	}
	if !actorProfileRe.MatchString(profile) {
		return "", fmt.Errorf("invalid actor profile %q (must match ^[a-z0-9][a-z0-9._@-]{0,39}$)", profile)
	}
	return profile, nil
}

func validateSourceNode(raw string) (string, error) {
	node := strings.TrimSpace(raw)
	if node == "" {
		return "", nil
	}
	if len(node) > boardChannelMaxLen || !sourceNodeRe.MatchString(node) {
		return "", fmt.Errorf("invalid --node %q (must match ^[a-z0-9][a-z0-9_-]*$ and <= %d chars)", node, boardChannelMaxLen)
	}
	return node, nil
}

func validateIdempotencyKey(raw string) (string, error) {
	k := strings.TrimSpace(raw)
	if k == "" {
		return "", nil
	}
	if len(k) < 8 || len(k) > 128 {
		return "", errors.New("--idempotency-key must be 8..128 characters")
	}
	return k, nil
}

func isValidBoardPostKind(kind string) bool {
	return kind == "note" || kind == "handoff" || kind == "artifact"
}

func isValidBoardTopicStatus(status string) bool {
	switch status {
	case "todo", "in_progress", "blocked", "done", "archived":
		return true
	default:
		return false
	}
}

func readBoardText(pos []string) (string, bool, error) {
	if len(pos) == 0 {
		return "", false, errors.New("message text or '-' (stdin) is required")
	}
	usedStdin := false
	var rawText string
	if len(pos) == 1 && pos[0] == "-" {
		usedStdin = true
		raw, err := io.ReadAll(io.LimitReader(os.Stdin, boardStdinMaxBytes+1))
		if err != nil {
			return "", true, err
		}
		if len(raw) > boardStdinMaxBytes {
			return "", true, fmt.Errorf("stdin text exceeds %d bytes", boardStdinMaxBytes)
		}
		rawText = string(raw)
	} else {
		rawText = strings.Join(pos, " ")
	}

	if strings.TrimSpace(rawText) == "" {
		return "", usedStdin, errors.New("message text cannot be empty")
	}
	redacted := redact.Text(rawText)
	if strings.TrimSpace(redacted) == "" {
		return "", usedStdin, errors.New("message text cannot be empty")
	}
	if rc := utf8.RuneCountInString(redacted); rc > boardTextMaxRunes {
		return "", usedStdin, fmt.Errorf("message text exceeds %d characters (got %d)", boardTextMaxRunes, rc)
	}
	return redacted, usedStdin, nil
}

func parseBoardDataFlag(rawFlag string, stdinUsed bool) (map[string]interface{}, error) {
	trimmed := strings.TrimSpace(rawFlag)
	if trimmed == "" {
		return nil, nil
	}
	var rawBytes []byte
	switch {
	case trimmed == "-":
		if stdinUsed {
			return nil, errors.New("cannot read both message text and --data from stdin")
		}
		b, err := io.ReadAll(io.LimitReader(os.Stdin, boardDataMaxBytes*2))
		if err != nil {
			return nil, err
		}
		rawBytes = b
	case strings.HasPrefix(trimmed, "@"):
		path := strings.TrimPrefix(trimmed, "@")
		if strings.TrimSpace(path) == "" {
			return nil, errors.New("invalid --data @file path")
		}
		b, err := os.ReadFile(config.ExpandPath(path))
		if err != nil {
			return nil, fmt.Errorf("read --data file: %w", err)
		}
		rawBytes = b
	default:
		rawBytes = []byte(trimmed)
	}

	dec := json.NewDecoder(bytes.NewReader(rawBytes))
	dec.UseNumber()
	var decoded interface{}
	if err := dec.Decode(&decoded); err != nil {
		return nil, fmt.Errorf("invalid --data JSON: %w", err)
	}
	var trailing interface{}
	if err := dec.Decode(&trailing); err != io.EOF {
		return nil, errors.New("--data must contain a single JSON object")
	}
	obj, ok := decoded.(map[string]interface{})
	if !ok || obj == nil {
		return nil, errors.New("--data must be a JSON object")
	}

	redacted := redact.Map(obj)
	encoded, err := json.Marshal(redacted)
	if err != nil {
		return nil, err
	}
	if len(encoded) > boardDataMaxBytes {
		return nil, fmt.Errorf("--data exceeds %d bytes after serialization (got %d)", boardDataMaxBytes, len(encoded))
	}
	return redacted, nil
}

func deriveBoardTopicTitle(explicitTitle, extRef, textMD string) string {
	if explicitTitle != "" {
		return boundRunes(explicitTitle, boardTitleMaxRunes)
	}
	if extRef != "" {
		return boundRunes(extRef, boardTitleMaxRunes)
	}
	for _, line := range strings.Split(textMD, "\n") {
		if t := strings.TrimSpace(line); t != "" {
			return boundRunes(t, 120)
		}
	}
	return "Board topic"
}

func redactBoardTopic(t *api.BoardTopic) {
	if t == nil {
		return
	}
	t.Title = redact.Text(t.Title)
	if t.LatestHandoff != nil {
		t.LatestHandoff.TextMD = redact.Text(t.LatestHandoff.TextMD)
		t.LatestHandoff.Data = redact.Map(t.LatestHandoff.Data)
		if t.LatestHandoff.Data == nil {
			t.LatestHandoff.Data = map[string]interface{}{}
		}
	}
}

func redactBoardMessage(m *api.BoardMessage) {
	if m == nil {
		return
	}
	m.TextMD = redact.Text(m.TextMD)
	m.Data = redact.Map(m.Data)
	if m.Data == nil {
		m.Data = map[string]interface{}{}
	}
	for i := range m.QuestionOptions {
		m.QuestionOptions[i] = redact.Text(m.QuestionOptions[i])
	}
}
