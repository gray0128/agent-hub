package main

import (
	"os"

	"github.com/gray0128/agent-hub/internal/cli"
)

var version = "dev"

func main() {
	os.Exit(cli.Execute(os.Args[1:], version))
}
