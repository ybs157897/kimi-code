package appdata

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

// testExpertsArchive returns a tar.gz byte stream with nested directories, a
// regular file, and hostile path-traversal members that must be skipped.
func testExpertsArchive(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)

	write := func(name string, typeflag byte, content string) {
		t.Helper()
		hdr := &tar.Header{Name: name, Typeflag: typeflag}
		if typeflag == tar.TypeReg {
			hdr.Size = int64(len(content))
			hdr.Mode = 0o644
		} else {
			hdr.Mode = 0o755
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("write header %s: %v", name, err)
		}
		if typeflag == tar.TypeReg {
			if _, err := tw.Write([]byte(content)); err != nil {
				t.Fatalf("write content %s: %v", name, err)
			}
		}
	}

	write("experts/", tar.TypeDir, "")
	write("experts/senior-developer/", tar.TypeDir, "")
	write("experts/senior-developer/SKILL.md", tar.TypeReg, "# senior-developer\n")
	write("experts/code-review-team/SKILL.md", tar.TypeReg, "# code-review\n")
	// Path-traversal members: a bare escape and a prefixed escape.
	write("../evil.txt", tar.TypeReg, "escape")
	write("experts/../../evil2.txt", tar.TypeReg, "escape2")

	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return buf.Bytes()
}

func TestExtractExpertsArchive(t *testing.T) {
	dest := t.TempDir()
	if err := extractExpertsArchive(bytes.NewReader(testExpertsArchive(t)), dest); err != nil {
		t.Fatalf("extractExpertsArchive() error: %v", err)
	}

	for _, want := range []struct {
		rel, content string
	}{
		{"senior-developer/SKILL.md", "# senior-developer\n"},
		{"code-review-team/SKILL.md", "# code-review\n"},
	} {
		got, err := os.ReadFile(filepath.Join(dest, "experts", want.rel))
		if err != nil {
			t.Fatalf("read experts/%s: %v", want.rel, err)
		}
		if string(got) != want.content {
			t.Fatalf("experts/%s = %q, want %q", want.rel, got, want.content)
		}
	}

	// Traversal members must not be written anywhere.
	for _, evil := range []string{"evil.txt", "evil2.txt"} {
		for _, dir := range []string{dest, filepath.Dir(dest)} {
			if _, err := os.Stat(filepath.Join(dir, evil)); !os.IsNotExist(err) {
				t.Fatalf("%s must not exist, stat error = %v", filepath.Join(dir, evil), err)
			}
		}
	}
}

func TestExtractExpertsArchiveRejectsForeignPrefix(t *testing.T) {
	dest := t.TempDir()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{Name: "other/root.txt", Typeflag: tar.TypeReg, Size: 3, Mode: 0o644}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}

	if err := extractExpertsArchive(bytes.NewReader(buf.Bytes()), dest); err != nil {
		t.Fatalf("extractExpertsArchive() error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "other")); !os.IsNotExist(err) {
		t.Fatalf("foreign member was extracted, stat error = %v", err)
	}
}
