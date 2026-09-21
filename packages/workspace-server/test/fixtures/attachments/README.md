# Chat attachment fixtures

These small, synthetic files test what reaches the inference provider through the public sessions API. They contain no user data. Text markers distinguish actual extraction from filenames or metadata. Word and PowerPoint include an embedded image; the PDF has text and vector artwork on two pages; the scan PDF contains only an image.

Created with Pillow and pillow-heif (images), reportlab (PDF), python-docx, openpyxl, python-pptx, and odfpy. The EPUB is a minimal ZIP with an OPF manifest and XHTML chapter. Tests use the checked-in files and do not require those generators. PDF conversion requires Poppler, which is installed in the workspace-server image.
