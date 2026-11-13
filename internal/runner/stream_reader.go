package runner

import (
	"bufio"
	"bytes"
	"errors"
	"io"
)

const MaxLineBytes = 2 * 1024 * 1024

// ReadLinesBounded reads arbitrarily long lines without bufio.Scanner's 64KB token limit failure.
func ReadLinesBounded(r io.Reader, onLine func(line []byte)) error {
	reader := bufio.NewReaderSize(r, 64*1024)
	var buf bytes.Buffer
	for {
		chunk, err := reader.ReadSlice('\n')
		if len(chunk) > 0 {
			if buf.Len()+len(chunk) <= MaxLineBytes {
				buf.Write(chunk)
			} else if buf.Len() < MaxLineBytes {
				remain := MaxLineBytes - buf.Len()
				buf.Write(chunk[:remain])
			}
		}

		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}

		if buf.Len() > 0 {
			line := bytes.TrimRight(buf.Bytes(), "\r\n")
			if len(line) > 0 {
				cp := make([]byte, len(line))
				copy(cp, line)
				onLine(cp)
			}
			buf.Reset()
		}

		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}
