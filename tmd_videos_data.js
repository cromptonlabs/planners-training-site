window.TMD_VIDEO_DATA = [
	// Add TMD training videos here, same format as videos_data.js:
	// ["TMD Training - Example Session.mp4", "https://drive.google.com/file/d/FILE_ID/preview?usp=sharing"],
	["TMD Training-20260901_230037UTC-Meeting Recording.mp4", "https://drive.google.com/file/d/1Uq6XpqHby6Yt8yE5hFVPh_qiBGDxXm6m/preview?usp=sharing"],
].map(([title, url]) => ({
	title,
	url,
	category: "TMD Training",
	library: "tmd"
}));
